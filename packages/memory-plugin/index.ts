/**
 * opencode Memory Compiler Plugin
 *
 * Bridges the claude-memory-compiler knowledge base into opencode sessions:
 * - Injects KB index + recent daily log into every chat's system prompt
 * - Injects KB index before context compaction
 * - Captures conversation when session goes idle → distills using configured model
 * - Generates Obsidian-optimized markdown with backlinks and YAML frontmatter
 *
 * Works great with Obsidian: symlink claude-memory-compiler/daily into your vault
 * and watch your knowledge graph build automatically.
 *
 * Configure in .opencode/opencode.jsonc:
 *   "plugin": [["../opencode/packages/memory-plugin/index.ts", {
 *     "kbDir": "./claude-memory-compiler",
 *     "distill": {
 *       "providerID": "openai",         // or "anthropic", "google", "groq", "ollama", etc.
 *       "modelID": "gpt-4o-mini",       // model to use for distillation
 *       "apiKey": "sk-...",             // optional, falls back to env var
 *       "baseURL": "http://..."         // optional, for openai-compatible providers
 *     }
 *   }]]
 */

import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { generateText } from "ai"

const MAX_INDEX_CHARS = 15_000
const MAX_LOG_LINES = 30
const FLUSH_DEDUP_MS = 60_000

const DEBUG_FILE = "/tmp/opencode-memory-plugin.log"

function debug(...args: unknown[]) {
  const msg = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`
  try { appendFileSync(DEBUG_FILE, msg) } catch {}
}

type ModelInfo = {
  providerID: string
  modelID: string
  apiKey?: string
  baseURL?: string
}

function resolveKbDir(pluginFileUrl: string, kbDirOption?: string): string {
  if (kbDirOption) {
    return resolve(process.cwd(), kbDirOption)
  }
  return resolve(dirname(fileURLToPath(pluginFileUrl)), "../../../claude-memory-compiler")
}

function readKbIndex(kbDir: string): string {
  const indexPath = join(kbDir, "knowledge", "index.md")
  if (!existsSync(indexPath)) return "(empty - no articles compiled yet)"
  const content = readFileSync(indexPath, "utf-8")
  return content.length > MAX_INDEX_CHARS
    ? content.slice(0, MAX_INDEX_CHARS) + "\n\n...(truncated)"
    : content
}

function readRecentLog(kbDir: string): string {
  const dailyDir = join(kbDir, "daily")
  const today = new Date()
  for (let offset = 0; offset < 2; offset++) {
    const d = new Date(today)
    d.setDate(d.getDate() - offset)
    const logPath = join(dailyDir, `${d.toISOString().slice(0, 10)}.md`)
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8").split("\n")
      return lines.slice(-MAX_LOG_LINES).join("\n")
    }
  }
  return "(no recent daily log)"
}

function formatMessages(messages: Array<{ info: any; parts: any[] }>): string {
  const turns: string[] = []
  for (const msg of messages) {
    const role = msg.info?.role
    if (role !== "user" && role !== "assistant") continue
    const text = (msg.parts ?? [])
      .filter((p: any) => p.type === "text" && !p.synthetic && p.text?.trim())
      .map((p: any) => p.text.trim())
      .join("\n")
    if (!text) continue
    turns.push(`**${role === "user" ? "User" : "Assistant"}:** ${text}`)
  }
  let context = turns.join("\n\n")
  if (context.length > 15_000) {
    context = context.slice(-15_000)
    const boundary = context.indexOf("\n**")
    if (boundary > 0) context = context.slice(boundary + 1)
  }
  return context
}

function appendToDaily(kbDir: string, content: string, section = "Session"): void {
  try {
    debug("appendToDaily", { kbDir, section, contentLength: content.length })
    const dailyDir = join(kbDir, "daily")
    const today = new Date()
    const dateStr = today.toISOString().slice(0, 10)
    const logPath = join(dailyDir, `${dateStr}.md`)
    mkdirSync(dailyDir, { recursive: true })
    if (!existsSync(logPath)) {
      writeFileSync(logPath, `# Daily Log: ${dateStr}\n\n## Sessions\n\n## Memory Maintenance\n\n`, "utf-8")
    }
    const timeStr = today.toTimeString().slice(0, 5)
    appendFileSync(logPath, `### ${section} (${timeStr})\n\n${content}\n\n`, "utf-8")
    debug("appendToDaily done")
  } catch (err) {
    debug("appendToDaily ERROR", err)
  }
}

async function getLanguageModel(info: ModelInfo) {
  const { providerID, modelID, apiKey, baseURL } = info

  switch (providerID) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      return createAnthropic({ apiKey })(modelID)
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      return createOpenAI({ apiKey, baseURL })(modelID)
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
      return createGoogleGenerativeAI({ apiKey })(modelID)
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq")
      return createGroq({ apiKey })(modelID)
    }
    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral")
      return createMistral({ apiKey })(modelID)
    }
    default: {
      // Ollama, LM Studio, and any other OpenAI-compatible provider
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
      return createOpenAICompatible({
        name: providerID,
        baseURL: baseURL ?? `http://localhost:11434/v1`,
        apiKey: apiKey ?? "ollama",
      })(modelID)
    }
  }
}

async function distillAndSave(kbDir: string, context: string, modelInfo: ModelInfo): Promise<void> {
  try {
    debug("distillAndSave", { providerID: modelInfo.providerID, modelID: modelInfo.modelID })
    const model = await getLanguageModel(modelInfo)

    const today = new Date().toISOString().split('T')[0]
    const prompt = `Review the conversation context below and respond with a concise summary
optimized for Obsidian. Use backlinks [[topic]] to create a knowledge graph.
Do NOT use any tools — just return markdown + YAML frontmatter.

START with YAML frontmatter on lines 1-5 (no code fence):
---
type: session
tags: [tag1, tag2, ...]
date: ${today}
---

THEN the content formatted exactly like this:

# Session: [One-line title extracted from the conversation]

## Outline
- [[MainTopic1]]: Brief one-liner
- [[MainTopic2]]: Brief one-liner

## Context
One sentence about what was discussed. Link key topics: [[topic1]], [[topic2]].

## Key Exchanges
- [[Topic1]]: Summary of discussion linking related concepts [[related-concept]]
- [[Topic2]]: What was learned, with backlinks to relevant areas

## Decisions Made
- [[ChosenApproach]]: Why this was chosen over [[Alternative1]] and [[Alternative2]]

## Lessons Learned
- Pattern about [[topic]]: The insight with link to related [[concept]]

## Related Topics
Link to connected areas: [[RelatedTopic1]], [[RelatedTopic2]]

## Action Items
- Research/explore [[next-topic]]
- Implement [[approach]] following [[pattern]]

RULES for backlinks:
- Extract EVERY key concept, framework, technology, and topic as [[PascalCase]]
- Link related concepts together throughout — this builds your knowledge graph
- Use WikiLink format: [[topic]] or [[topic|display text]]
- Create backlinks even if the article doesn't exist yet — Obsidian will show "broken links" you should write about

Skip anything that is:
- Routine tool calls or file reads
- Trivial back-and-forth
- Obvious content

If nothing is worth saving, respond with exactly: FLUSH_OK

## Conversation Context

${context}`

    const { text } = await generateText({ model, prompt, maxTokens: 1024 })

    if (text.includes("FLUSH_OK")) {
      appendToDaily(kbDir, "FLUSH_OK - Nothing worth saving from this session", "Memory Distillation")
    } else {
      appendToDaily(kbDir, text, "Session")
    }
  } catch (e) {
    debug("distillAndSave ERROR", e)
    appendToDaily(kbDir, `DISTILL_ERROR: ${e}`, "Memory Distillation")
  }
}

const plugin: Plugin = async (input: PluginInput, options?: Record<string, any>): Promise<Hooks> => {
  const kbDir = resolveKbDir(import.meta.url, options?.kbDir as string | undefined)
  const client = input.client

  // Explicit distill model from config — used for distillation instead of the session model.
  // Required when the session model is an internal provider (e.g. "opencode/big-pickle").
  const distillConfig: ModelInfo | undefined = options?.distill
    ? {
        providerID: options.distill.providerID as string,
        modelID: options.distill.modelID as string,
        apiKey: options.distill.apiKey as string | undefined,
        baseURL: options.distill.baseURL as string | undefined,
      }
    : undefined

  try { writeFileSync(DEBUG_FILE, `=== PLUGIN INIT ${new Date().toISOString()} ===\n`) } catch {}
  debug("PLUGIN INIT", { kbDir, distillConfig })

  const lastFlushAt = new Map<string, number>()
  // Fallback: capture model/provider info from chat.params (only for real external providers)
  const sessionModels = new Map<string, ModelInfo>()

  return {
    // Capture which model is active for each session (best-effort, may not fire for all providers)
    "chat.params": async (hookInput) => {
      try {
        debug("chat.params fired", hookInput.sessionID)
        const provider = (hookInput as any).provider
        const model = (hookInput as any).model

        const providerID: string = provider?.info?.id ?? provider?.id ?? ""
        const modelID: string = model?.id ?? model?.modelID ?? ""

        // Skip internal opencode routing providers — they can't be called via AI SDK
        if (!providerID || providerID === "opencode") {
          debug("chat.params skipping internal provider", { providerID, modelID })
          return
        }

        // Resolve API key from provider options or env vars listed in provider.info.env
        const envKey = (provider?.info?.env as string[] | undefined)
          ?.map((k: string) => process.env[k])
          .find(Boolean)

        const modelInfo: ModelInfo = {
          providerID,
          modelID,
          apiKey: provider?.options?.apiKey ?? envKey,
          baseURL: provider?.options?.baseURL,
        }
        sessionModels.set(hookInput.sessionID, modelInfo)
        debug("model stored", hookInput.sessionID, modelInfo)
      } catch (err) {
        debug("chat.params ERROR (non-fatal)", err)
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      debug("system.transform fired")
      try {
        const index = readKbIndex(kbDir)
        const recentLog = readRecentLog(kbDir)
        const today = new Date().toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        })
        output.system.push(
          `## Personal Knowledge Base\n\n` +
          `**Today:** ${today}\n\n` +
          `### Knowledge Base Index\n\n${index}\n\n` +
          `### Recent Daily Log\n\n${recentLog}`
        )
      } catch (err) {
        debug("system.transform ERROR", err)
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      debug("compacting fired")
      try {
        output.context.push(`## Knowledge Base Index\n\n${readKbIndex(kbDir)}`)
      } catch (err) {
        debug("compacting ERROR", err)
      }
    },

    event: async ({ event }) => {
      const e = event as any
      debug("EVENT", e.type, e.properties)

      const isIdle =
        (e.type === "session.status" && e.properties?.status?.type === "idle") ||
        e.type === "session.idle"
      if (!isIdle) return

      debug("IDLE DETECTED", e.type)

      const sessionId: string | undefined = e.properties?.sessionID ?? e.properties?.sessionId
      if (!sessionId) {
        debug("NO SESSION ID")
        return
      }

      const now = Date.now()
      if (now - (lastFlushAt.get(sessionId) ?? 0) < FLUSH_DEDUP_MS) {
        debug("DEDUP", sessionId)
        return
      }
      lastFlushAt.set(sessionId, now)

      // Prefer explicit distill config, fall back to captured session model
      const modelInfo = distillConfig ?? sessionModels.get(sessionId)
      if (!modelInfo) {
        debug("NO MODEL INFO", sessionId)
        appendToDaily(kbDir, "DISTILL_SKIP: No model configured — add a 'distill' option in opencode.jsonc", "Memory Distillation")
        return
      }

      debug("STARTING DISTILL", sessionId, modelInfo)
      setImmediate(async () => {
        try {
          const result = await (client.session as any).messages({ path: { id: sessionId }, query: { limit: 50 } })
          const messages = result?.data as Array<{ info: any; parts: any[] }> | undefined
          debug("GOT MESSAGES", messages?.length)
          if (!messages?.length) return
          const context = formatMessages(messages)
          if (!context.trim()) return
          debug("DISTILLING...")
          await distillAndSave(kbDir, context, modelInfo)
          debug("DONE")
        } catch (err) {
          debug("DISTILL ERROR", err)
          appendToDaily(kbDir, `DISTILL_ERROR: ${err}`, "Memory Distillation")
        }
      })
    },
  }
}

export default {
  id: "memory-compiler",
  server: plugin,
}
