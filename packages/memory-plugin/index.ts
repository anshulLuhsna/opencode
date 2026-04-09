/**
 * opencode Memory Compiler Plugin
 *
 * Bridges the claude-memory-compiler knowledge base into opencode sessions:
 * - Injects KB index + recent daily log into every chat's system prompt
 * - Injects KB index before context compaction
 * - Captures conversation when session goes idle → distills using opencode's configured model
 *
 * Configure in .opencode/config.jsonc:
 *   "plugin": [["./opencode/packages/memory-plugin/index.ts", { "kbDir": "./claude-memory-compiler" }]]
 */

import type { Plugin, Hooks, PluginInput, ProviderContext } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk"
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { generateText } from "ai"

const MAX_INDEX_CHARS = 15_000
const MAX_LOG_LINES = 30
const FLUSH_DEDUP_MS = 60_000

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
  } catch {}
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
    const model = await getLanguageModel(modelInfo)

    const prompt = `Review the conversation context below and respond with a concise summary
of important items that should be preserved in the daily log.
Do NOT use any tools — just return plain text.

Format your response as a structured daily log entry with these sections:

**Context:** [One line about what the user was working on]

**Key Exchanges:**
- [Important Q&A or discussions]

**Decisions Made:**
- [Any decisions with rationale]

**Lessons Learned:**
- [Gotchas, patterns, or insights discovered]

**Action Items:**
- [Follow-ups or TODOs mentioned]

Skip anything that is:
- Routine tool calls or file reads
- Content that's trivial or obvious
- Trivial back-and-forth or clarification exchanges

Only include sections that have actual content. If nothing is worth saving,
respond with exactly: FLUSH_OK

## Conversation Context

${context}`

    const { text } = await generateText({ model, prompt, maxTokens: 1024 })

    if (text.includes("FLUSH_OK")) {
      appendToDaily(kbDir, "FLUSH_OK - Nothing worth saving from this session", "Memory Distillation")
    } else {
      appendToDaily(kbDir, text, "Session")
    }
  } catch (e) {
    appendToDaily(kbDir, `DISTILL_ERROR: ${e}`, "Memory Distillation")
  }
}

const plugin: Plugin = async (input: PluginInput, options?: Record<string, any>): Promise<Hooks> => {
  const kbDir = resolveKbDir(import.meta.url, options?.kbDir as string | undefined)
  const client = input.client

  const lastFlushAt = new Map<string, number>()
  // Capture model/provider info from chat.params as sessions send messages
  const sessionModels = new Map<string, ModelInfo>()

  return {
    // Capture which model is active for each session
    "chat.params": async (hookInput) => {
      const provider = hookInput.provider as ProviderContext
      const model = hookInput.model as Model
      // Resolve API key: provider.options.apiKey first, then fall back to env vars listed in provider.info.env
      const envKey = (provider.info as any).env?.map((k: string) => process.env[k]).find(Boolean)
      sessionModels.set(hookInput.sessionID, {
        providerID: provider.info.id,
        modelID: (model as any).id ?? (model as any).modelID ?? "",
        apiKey: (provider.options as any)?.apiKey ?? envKey,
        baseURL: (provider.options as any)?.baseURL,
      })
    },

    "experimental.chat.system.transform": async (_input, output) => {
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
      } catch {}
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        output.context.push(`## Knowledge Base Index\n\n${readKbIndex(kbDir)}`)
      } catch {}
    },

    event: async ({ event }) => {
      const e = event as any
      const isIdle =
        (e.type === "session.status" && e.properties?.status?.type === "idle") ||
        e.type === "session.idle"
      if (!isIdle) return

      const sessionId: string | undefined = e.properties?.sessionID ?? e.properties?.sessionId
      if (!sessionId) return

      const now = Date.now()
      if (now - (lastFlushAt.get(sessionId) ?? 0) < FLUSH_DEDUP_MS) return
      lastFlushAt.set(sessionId, now)

      const modelInfo = sessionModels.get(sessionId)
      if (!modelInfo) {
        appendToDaily(kbDir, "DISTILL_SKIP: No model info captured for this session", "Memory Distillation")
        return
      }

      setImmediate(async () => {
        try {
          const result = await (client.session as any).messages({ sessionID: sessionId, limit: 50 })
          const messages = result?.data as Array<{ info: any; parts: any[] }> | undefined
          if (!messages?.length) return
          const context = formatMessages(messages)
          if (!context.trim()) return
          await distillAndSave(kbDir, context, modelInfo)
        } catch {}
      })
    },
  }
}

export default {
  id: "memory-compiler",
  server: plugin,
}
