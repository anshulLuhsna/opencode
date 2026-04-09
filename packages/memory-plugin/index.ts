/**
 * opencode Memory Compiler Plugin
 *
 * Bridges the claude-memory-compiler knowledge base into opencode sessions:
 * - Injects KB index + recent daily log into every chat's system prompt
 * - Injects KB index before context compaction
 * - Captures conversation when a session goes idle → distills with Anthropic SDK
 *
 * Configure in .opencode/config.jsonc:
 *   "plugin": [["./opencode/packages/memory-plugin/index.ts", { "kbDir": "./claude-memory-compiler" }]]
 */

import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"

const MAX_INDEX_CHARS = 15_000
const MAX_LOG_LINES = 30
const FLUSH_DEDUP_MS = 60_000

function resolveKbDir(pluginFileUrl: string, kbDirOption?: string): string {
  if (kbDirOption) {
    return resolve(process.cwd(), kbDirOption)
  }
  // Default: look for claude-memory-compiler sibling of the opencode dir
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
    const dateStr = d.toISOString().slice(0, 10)
    const logPath = join(dailyDir, `${dateStr}.md`)
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
    const textParts = (msg.parts ?? [])
      .filter((p: any) => p.type === "text" && !p.synthetic && p.text?.trim())
      .map((p: any) => p.text.trim())
    if (textParts.length === 0) continue
    const label = role === "user" ? "User" : "Assistant"
    turns.push(`**${label}:** ${textParts.join("\n")}`)
  }
  let context = turns.join("\n\n")
  if (context.length > 15_000) {
    context = context.slice(-15_000)
    const boundary = context.indexOf("\n**")
    if (boundary > 0) context = context.slice(boundary + 1)
  }
  return context
}

function appendToDaily(kbDir: string, content: string, section: string = "Session"): void {
  try {
    const dailyDir = join(kbDir, "daily")
    const today = new Date()
    const dateStr = today.toISOString().slice(0, 10)
    const logPath = join(dailyDir, `${dateStr}.md`)

    mkdirSync(dailyDir, { recursive: true })

    if (!existsSync(logPath)) {
      writeFileSync(
        logPath,
        `# Daily Log: ${dateStr}\n\n## Sessions\n\n## Memory Maintenance\n\n`,
        "utf-8"
      )
    }

    const timeStr = today.toTimeString().slice(0, 5)
    const entry = `### ${section} (${timeStr})\n\n${content}\n\n`
    appendFileSync(logPath, entry, "utf-8")
  } catch (e) {
    console.error(`Failed to append to daily log: ${e}`)
  }
}

async function distillAndSave(
  kbDir: string,
  context: string,
  sessionId: string,
  client: any
): Promise<void> {
  try {
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

    // Use opencode's configured model (whatever the user has set up)
    let result = ""
    try {
      // Try streaming API if available
      const stream = await (client as any).prompt?.({
        prompt,
        stream: true,
      })
      if (stream) {
        for await (const chunk of stream) {
          if (typeof chunk === "string") result += chunk
          else if (chunk?.text) result += chunk.text
        }
      }
    } catch {
      // Fall back to non-streaming if available
      const response = await (client as any).prompt?.({ prompt })
      result = typeof response === "string" ? response : response?.text || ""
    }

    if (!result) {
      appendToDaily(kbDir, "DISTILL_ERROR: No response from model", "Memory Distillation")
      return
    }

    if (result.includes("FLUSH_OK")) {
      appendToDaily(kbDir, "FLUSH_OK - Nothing worth saving from this session", "Memory Distillation")
    } else {
      appendToDaily(kbDir, result, "Session")
    }
  } catch (e) {
    appendToDaily(kbDir, `DISTILL_ERROR: ${e}`, "Memory Distillation")
  }
}

const plugin: Plugin = async (input: PluginInput, options?: Record<string, any>): Promise<Hooks> => {
  const kbDir = resolveKbDir(import.meta.url, options?.kbDir as string | undefined)
  const client = input.client

  const lastFlushAt = new Map<string, number>()

  return {
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
        const index = readKbIndex(kbDir)
        output.context.push(`## Knowledge Base Index\n\n${index}`)
      } catch {}
    },

    event: async ({ event }) => {
      const e = event as any
      const isIdle =
        (e.type === "session.status" && e.properties?.status?.type === "idle") ||
        e.type === "session.idle"

      if (!isIdle) return

      const sessionId: string | undefined =
        e.properties?.sessionID ?? e.properties?.sessionId
      if (!sessionId) return

      const now = Date.now()
      if (now - (lastFlushAt.get(sessionId) ?? 0) < FLUSH_DEDUP_MS) return
      lastFlushAt.set(sessionId, now)

      setImmediate(async () => {
        try {
          const result = await (client.session as any).messages({
            sessionID: sessionId,
            limit: 50,
          })
          const messages = result?.data as Array<{ info: any; parts: any[] }> | undefined
          if (!messages?.length) return

          const context = formatMessages(messages)
          if (!context.trim()) return

          await distillAndSave(kbDir, context, sessionId, client)
        } catch {}
      })
    },
  }
}

export default {
  id: "memory-compiler",
  server: plugin,
}
