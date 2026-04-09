# opencode Memory Plugin

Gives opencode a persistent memory across sessions. Every conversation is automatically captured, summarized, and injected back into future sessions — so your AI assistant remembers what you've worked on, decisions you've made, and lessons you've learned.

## How it works

1. **Session starts** — the plugin reads your knowledge base index and recent daily log and injects them into the system prompt so the assistant has context from past sessions.
2. **Session ends (goes idle)** — the plugin fetches the conversation, sends it to your configured LLM, and appends a structured summary to today's daily log.
3. **Context compaction** — the KB index is re-injected before opencode compacts context so nothing is lost mid-session.

Over time the daily logs accumulate. You can compile them into a permanent knowledge base using the [claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler) scripts — but that step is optional.

---

## Prerequisites

- This fork of opencode (the plugin uses internal hooks not in the upstream repo)
- [Bun](https://bun.sh) (opencode's runtime)
- An API key for any supported LLM provider (see [Supported providers](#supported-providers))
- [claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler) cloned somewhere on your machine

---

## Setup

### 1. Clone the knowledge base

```bash
git clone https://github.com/coleam00/claude-memory-compiler /path/to/your/kb
```

This gives you the `daily/` and `knowledge/` directory structure the plugin reads and writes to.

### 2. Install plugin dependencies

```bash
cd opencode/packages/memory-plugin
bun install
```

### 3. Create `.opencode/opencode.jsonc` in your project root

This is the opencode config file for your project (or globally at `~/.config/opencode/opencode.jsonc`).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      // Path to the plugin, relative to this config file
      "../opencode/packages/memory-plugin/index.ts",
      {
        // Path to your cloned knowledge base, relative to this config file
        "kbDir": "./claude-memory-compiler",

        // The model used to summarize conversations after each session.
        // This must be a real external provider — see Supported Providers below.
        "distill": {
          "providerID": "groq",
          "modelID": "llama-3.3-70b-versatile",
          "apiKey": "gsk_..."
        }
      }
    ]
  ]
}
```

Adjust the paths to match where your opencode fork and knowledge base actually live relative to your project.

---

## Supported providers

The `distill` block accepts any of the following providers. Only `providerID` and `modelID` are required — `apiKey` and `baseURL` are optional when you have the relevant environment variable set.

### Groq (free tier)

Fast inference, generous free tier. Recommended if you don't want to spend credits.

```jsonc
"distill": {
  "providerID": "groq",
  "modelID": "llama-3.3-70b-versatile",
  "apiKey": "gsk_..."
}
```

Get a key at [console.groq.com](https://console.groq.com). Other good free models: `llama-3.1-8b-instant`, `gemma2-9b-it`.

Environment variable fallback: `GROQ_API_KEY`

### OpenAI

```jsonc
"distill": {
  "providerID": "openai",
  "modelID": "gpt-4o-mini",
  "apiKey": "sk-..."
}
```

Environment variable fallback: `OPENAI_API_KEY`

### Google Gemini (free tier available)

```jsonc
"distill": {
  "providerID": "google",
  "modelID": "gemini-2.0-flash",
  "apiKey": "AIza..."
}
```

Get a key at [aistudio.google.com](https://aistudio.google.com). Environment variable fallback: `GOOGLE_GENERATIVE_AI_API_KEY`

### Anthropic

```jsonc
"distill": {
  "providerID": "anthropic",
  "modelID": "claude-haiku-4-5-20251001",
  "apiKey": "sk-ant-..."
}
```

Haiku is extremely cheap (~$0.001 per distillation). Environment variable fallback: `ANTHROPIC_API_KEY`

### Mistral

```jsonc
"distill": {
  "providerID": "mistral",
  "modelID": "mistral-small-latest",
  "apiKey": "..."
}
```

Environment variable fallback: `MISTRAL_API_KEY`

### Ollama (local, no API key needed)

```jsonc
"distill": {
  "providerID": "ollama",
  "modelID": "llama3.2",
  "baseURL": "http://localhost:11434/v1"
}
```

Any model you have pulled with `ollama pull <model>` works. No API key required.

### Any OpenAI-compatible provider (LM Studio, vLLM, Together, etc.)

```jsonc
"distill": {
  "providerID": "lmstudio",
  "modelID": "your-model-name",
  "baseURL": "http://localhost:1234/v1",
  "apiKey": "lm-studio"
}
```

If `providerID` doesn't match one of the named providers above, the plugin automatically uses the OpenAI-compatible adapter with your `baseURL`.

---

## Verification

After setup, start opencode and have a short conversation (at least one exchange). When the session goes idle or you close it, check:

**Debug log** — real-time plugin activity:
```bash
tail -f /tmp/opencode-memory-plugin.log
```

A successful distillation looks like:
```
IDLE DETECTED session.status
STARTING DISTILL ses_...
GOT MESSAGES 4
DISTILLING...
distillAndSave { providerID: 'groq', modelID: 'llama-3.3-70b-versatile' }
DONE
```

**Daily log** — the actual captured entry:
```bash
cat /path/to/your/kb/daily/$(date +%F).md
```

You should see a `### Session (HH:MM)` block with structured sections: Context, Key Exchanges, Decisions Made, Lessons Learned, Action Items.

---

## Compiling the knowledge base (optional)

The daily logs are useful on their own, but the memory compiler can also distill them into permanent articles in `knowledge/`. Those articles get injected into every future session.

```bash
cd /path/to/your/kb
uv run python scripts/compile.py
```

See the [claude-memory-compiler README](https://github.com/coleam00/claude-memory-compiler) for the full compilation workflow.

---

## Troubleshooting

**`GOT MESSAGES undefined`** — wrong session ID parameter. Make sure you're on the latest version of this plugin (the fix is in the `path: { id }` call).

**`DISTILL_SKIP: No model configured`** — the `distill` block is missing from your `opencode.jsonc`. The plugin cannot use opencode's internal routing model for distillation.

**`DISTILL_ERROR: ...`** — usually a bad API key or model name. Check the error text in the daily log and verify your `distill` config.

**System prompt not injecting** — check that the `kbDir` path resolves correctly. The plugin looks for `<kbDir>/knowledge/index.md`. Run `ls /path/to/your/kb/knowledge/` to confirm the directory exists (it may be empty until you run compile.py, which is fine).
