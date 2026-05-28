# oc-kunwei

An [opencode](https://opencode.ai) plugin that provides a curated set of tools, agents, and workflow commands for structured, review-gated development.

## Features

### Tools

| Tool | Agent | Description |
|------|-------|-------------|
| `basher` | basher | Execute shell commands via a dedicated sub-session with timeout enforcement and pipe stripping |
| `editor` | editor | Delegate file edits (read, write, edit) to a sub-session |
| `explorer` | explorer | Semantic code search via semble MCP; read-only exploration |
| `reverie` | reverie | Deep contemplation sub-session with no tools — pure text thinking |
| `websearch` | — | Web search via ollama.com API |
| `webfetch` | — | URL fetch via ollama.com API |
| `submit_review` | — | Submit work for review (only during `/with-review` mode) |
| `submit_review_result` | — | Reviewer submits verdict (accept with `null`, reject with feedback) |

### Commands

| Command | Description |
|---------|-------------|
| `/with-review <task>` | Activate review-gated mode for a task. The LLM must submit work via `submit_review`, which spawns a reviewer sub-session. One-shot — mode ends after review. |

### Agents

| Agent | Mode | Tools | Purpose |
|-------|------|-------|---------|
| **orchestrator** | foreground | basher, editor, explorer (no bash/edit/write/glob/grep) | Main conversation — delegates all work |
| **basher** | subagent | bash | Shell execution with `timeout 1` enforcement |
| **editor** | subagent | read, write, edit, basher | File modifications |
| **explorer** | subagent | read, basher + semble MCP | Read-only code exploration |
| **reverie** | subagent | *(none)* | Text-only deep thinking |
| **reviewer** | *(reuses explorer)* | read, basher + semble MCP + submit_review_result | Code review with structured verdict |

### Hooks

| Hook | Purpose |
|------|---------|
| `tool.execute.before` (bash) | Strips `\| head/tail` pipes and enforces `timeout 1` on all bash commands |
| `command.execute.before` | Intercepts `/with-review` — rewrites task into a structured prompt |
| `event` (session.idle) | Nudge hook: if in with-review mode with no open todos, reminds LLM to call `submit_review` |
| `experimental.chat.system.transform` | Injects `*_CAPS.md` file contents into system prompts |

### Workflow: `/with-review`

```
User: /with-review Refactor the auth module to use JWT

  └─► LLM works on the task
      └─► LLM calls submit_review({ report, affectedFiles })
          └─► Reviewer sub-session spawned (explorer agent)
              ├─► Reviewer calls submit_review_result(null)     → accepted
              └─► Reviewer calls submit_review_result("...")    → rejected, LLM gets feedback
          └─► If reviewer ends without calling tool → nudged (up to 3 times)
      └─► Review result returned to LLM
  └─► with-review mode ends (one-shot)
```

Todo nudge takes priority over review nudge — if there are incomplete todos, the review nudge is suppressed.

## Setup

```bash
bun install
cp src/ollama-web/key.ts.example src/ollama-web/key.ts
# Edit key.ts with your OLLAMA_API_KEY
```

## Build & Test

```bash
bun run build          # Bundle to dist/index.js
bun run typecheck      # TypeScript check
bun test src/          # Run all tests
bun run check          # Biome lint + format
```

## Install in opencode

In your `opencode.jsonc`:

```jsonc
{
  "plugin": ["file:///path/to/oc-kunwei"]
}
```

## Architecture

```
src/
├── index.ts           Plugin entry point — registers all tools, hooks, agents
├── basher/            Shell execution with timeout + pipe stripping
├── editor/            File edit delegation
├── explorer/          Semantic code search via semble
├── reverie/           Tool-free contemplation sub-session
├── nudge-todo/        Auto-continue on idle when todos are incomplete
├── ollama-web/        Web search/fetch via ollama.com
├── refer-caps/        Inject ALL_CAPS markdown files into system prompts
└── with-review/       /with-review command + review workflow
```
