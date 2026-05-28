# oc-kunwei

[![Plugin version](https://img.shields.io/badge/version-0.1.0-blue)](https://opencode.ai)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)](https://opencode.ai)
[![Bun](https://img.shields.io/badge/Bun-≥1.3-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org)

**oc-kunwei** is an [opencode](https://opencode.ai) plugin that provides a curated set of tools, specialized subagents, and workflow commands for structured, review-gated development. It implements a **least-privilege subagent delegation** architecture where the orchestrator never touches files or runs commands directly — all work is delegated to purpose-built subagents with minimal permissions.

---

## Why oc-kunwei?

### 🛡️ Least-Privilege Subagent Delegation

The orchestrator agent (the main LLM conversation) has all dangerous capabilities revoked — no `bash`, no `edit`, no `write`, no `glob`, no `grep`. Instead, it delegates every operation to a specialized subagent via a dedicated child session:

| Subagent | Can Do | Cannot Do |
|----------|--------|-----------|
| **basher** | Run bash commands (with `timeout 1`) | Read/write files, edit code |
| **editor** | Read, write, edit files + run bash | Access semblle, web, or review tools |
| **explorer** | Read files + semblle semantic search + bash | Write or edit any file |
| **reverie** | Pure text thinking — no tools at all | Use any tool |

This means the orchestrator can only orchestrate. It must explicitly choose which subagent to invoke, making every operation deliberate and auditable.

### ✅ Review-Gated Development

The `/loop` command activates a one-shot review gate: the LLM works on a task, submits a report via `submit_review`, and a dedicated reviewer agent (sandboxed in the explorer agent) evaluates the work against eight rigorous criteria. The result is either **accepted** (feedback is `null`) or **rejected** with specific, actionable feedback.

### 📄 Context Injection via CAPS Files

The `experimental.chat.system.transform` hook automatically discovers and injects `*_CAPS.md` files (or files inside `*_CAPS/` directories) at the project root into the system prompt. This allows teams to define project-wide conventions, architecture guidelines, or API contracts as plain markdown files that are always present in the LLM's context — without cluttering individual prompts.

---

## Tools

### `basher`

Execute shell commands via a dedicated basher sub-session. The orchestrator cannot run bash directly — it must go through this tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | ✅ | The bash command to execute. Do **not** wrap with `timeout(1)` — it is added automatically. |
| `what_to_summarize` | `string` | ✅ | Describes what to look for in the output. Be specific to get a focused natural-language summary. |

The tool:
1. Strips any `| head -n N` / `| tail -N` pipes (these are common LLM artifacts that interfere with command output).
2. Wraps the command as `timeout 1 bash -c '...'` to enforce a 1-second hard limit.
3. Spawns a **basher** subagent child session.
4. Returns a natural-language summary, not the raw output.

> **Restriction:** The `bash` built-in tool is denied for the orchestrator. All shell execution must go through `basher`.

---

### `editor`

Delegates a code editing task to a dedicated editor subagent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | `string` | ✅ | Detailed description of the editing task — include file paths, specific changes, and any relevant context. |

The editor subagent can:
- Read files (`read`)
- Write new files (`write`)
- Edit existing files (`edit`)
- Run commands via `basher` (e.g., `npm test`, `bun run build`)

It **cannot** use web search, semblle, or review tools.

---

### `explorer`

Perform semantic code search using semblle MCP and read-only exploration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | ✅ | Natural-language search query describing the code to find (e.g., "Where is the authentication middleware defined?"). |

The explorer subagent has:
- `read` permission (can read file contents)
- `basher` tool for read-only commands (listing files, git status, etc.)
- **semble** MCP for semantic code search
- `write` and `edit` are **denied** — it cannot modify files

> **Note:** The explorer's system prompt explicitly warns against using `basher` to modify files. If changes are needed, it must report back rather than act.

---

### `reverie`

A tool-free contemplation sub-session for deep thinking. No commands, no search, no file access — just the question and the provided files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | `string` | ✅ | The question to contemplate. The harder, the better. |
| `files` | `string[]` | ✅ | File paths to provide as context. Contents are read and embedded in the prompt. |

The reverie agent has **no tools** at all. Its system prompt sets the scene: *"No tools, no distractions — just you and the problem."* Use this for design decisions, bug analysis, code review preparation, or any situation that benefits from undistracted reasoning.

---

### `websearch`

Search the web via the ollama.com API.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | ✅ | Natural language search query. Describe the ideal page, not keywords. |
| `numResults` | `number` | ❌ | Number of search results to return (default: `10`). |

**Query tips:**
- `"blog post comparing React and Vue performance"` — not `"React vs Vue"`
- `"category:people John Doe"` — search LinkedIn profiles
- `"category:company Acme Corp"` — search companies

---

### `webfetch`

Fetch a URL with intelligent content extraction via the ollama.com API.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | ✅ | The URL to fetch (http: and https: only). |
| `extract_main` | `boolean` | ❌ | Extract main content, removing navigation and ads (default: `true`). |
| `prefer_llms_txt` | `"auto"` \| `"always"` \| `"never"` | ❌ | Probe for `llms.txt` files before fetching full page (default: `auto`). |
| `prompt` | `string` | ❌ | Optional extraction task processed by a cheap secondary model. |
| `timeout` | `number` | ❌ | Timeout in seconds (max: `120`). |

Returns: title, byline, content length, and the extracted content.

---

### `submit_review`

Submit work for review. **Only available during `/loop` mode.**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `report` | `string` | ✅ | Detailed report of what was done and why. |
| `affectedFiles` | `string[]` | ✅ | List of every file path that was modified or created. |

Once called, a reviewer sub-session is spawned (using the explorer agent with the addition of `submit_review_result`). The reviewer evaluates the work and submits a verdict.

---

### `submit_review_result`

The reviewer's tool for submitting a verdict. **Only available to the reviewer sub-session.**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `feedback` | `string` \| `null` | ✅ | `null` = **accept**. Non-null string = **reject** with specific actionable feedback. |

> **Important:** If accepting, `feedback` must be exactly `null`. Any text — including praise — is treated as rejection feedback.

---

## Commands

| Command | Description |
|---------|-------------|
| **`/loop <task>`** | Activates one-shot review-gated mode. Rewrites the task into a structured prompt that tells the LLM to complete the work and then call `submit_review`. The mode ends after the review is resolved. |

---

## Agents

### Orchestrator (Foreground)

- **Tools available:** `basher`, `editor`, `explorer`
- **Explicitly denied:** `bash`, `edit`, `write`, `glob`, `grep`
- **semble permission:** `deny` (cannot use semblle directly — must use `explorer`)
- **Purpose:** The main conversation agent. It orchestrates work by delegating to subagents. It can think, plan, and call specialized tools, but it cannot touch files or run shell commands directly.

### basher (Subagent)

- **Mode:** `subagent`
- **Tools:** `bash` (only)
- **Permissions:** `*: deny`, `bash: allow`
- **semble permission:** `deny`
- **System prompt:** Expert at analyzing terminal output. Returns natural-language summaries.
- **Purpose:** Execute shell commands with `timeout 1` enforcement and pipe stripping. Summarizes output in natural language.

### editor (Subagent)

- **Mode:** `subagent`
- **Tools:** `basher` (explicitly enabled)
- **Permissions:** `*: deny`, `read: allow`, `write: allow`, `edit: allow`
- **semble permission:** `deny`
- **System prompt:** Code editing assistant — reads files, edits files, writes new files, runs commands.
- **Purpose:** Perform file modifications. Can read, edit, write, and run verification commands.

### explorer (Subagent)

- **Mode:** `subagent`
- **Tools:** `basher` (explicitly enabled)
- **Permissions:** `*: deny`, `read: allow`
- **semble permission:** `allow` (the only agent with semblle access)
- **MCPs:** `semble`
- **System prompt:** Code exploration agent. Uses semblle for semantic search. Reads files for context. WARNED against modifying files.
- **Purpose:** Read-only code exploration and semantic search. Used as the base for the reviewer agent.

### reverie (Subagent)

- **Mode:** `subagent`
- **Tools:** *(none)*
- **Permissions:** None granted
- **System prompt:** Quiet contemplation — no tools, no distractions.
- **Purpose:** Pure text-based deep thinking. No tools available at all.

### reviewer (Reuses explorer)

- **Mode:** subagent (spawned dynamically)
- **Base agent:** `explorer` (inherits all its tools and permissions)
- **Additional tool:** `submit_review_result`
- **System prompt:** Rigorous code reviewer with eight evaluation criteria (see Workflow section).
- **Purpose:** Review submitted work and return a structured verdict. Nudged up to 3 times if it ends without calling `submit_review_result`.

---

## Hooks

### `tool.execute.before` (bash interception)

| Trigger | Action |
|---------|--------|
| Any `bash` tool execution | 1. Strips `\| head\|tail` pipes (common LLM hallucination artifacts). 2. Wraps the command in `timeout 1 bash -c '...'` to enforce a 1-second hard limit. |

This hook runs on every `bash` invocation, including those from subagents. The pipe-stripping logic is recursive — multiple pipes are all removed, and each removal is recorded for diagnostics.

### `command.execute.before` (`/loop` interception)

| Trigger | Action |
|---------|--------|
| User types `/loop <task>` | Intercepts the command, flags the session as review-gated, and rewrites the prompt into a structured instruction: "Complete the task, then call `submit_review` with a report and affected files list. A reviewer will examine your submission." |

The command registration in `opencodeConfig` sets up `/loop` as a proper opencode command with description and template.

### `event` (session.idle — nudge hooks)

Two independent nudge hooks run on idle events:

| Hook | Condition | Action |
|------|-----------|--------|
| **nudge-todo** | Session is idle AND there are incomplete todos (not `completed` or `cancelled`) | Prompts the LLM: *"There are still incomplete todos. Continue working through the remaining items."* |
| **loop nudge** | Session is idle AND session is in `/loop` mode AND there are **no** open todos (todos take priority) | Prompts the LLM: *"You must call `submit_review` before finishing."* |

The loop nudge runs **only** if todos are complete — incomplete todos suppress the review nudge. Both nudges have a 5-second suppression window after an abort error.

### `experimental.chat.system.transform` (CAPS context injection)

| Trigger | Action |
|---------|--------|
| Every chat initialization | Discovers all `*_CAPS.md` files (or files inside `*_CAPS/` directories) at the project root, reads their content, and appends them to the system prompt wrapped in `<caps-context>` tags. |

**File discovery rules:**
- Matches files matching `^[A-Z][A-Z0-9_]*\.md$` at the project root.
- Also scans directories matching `^[A-Z][A-Z0-9_]*$` recursively for all files.
- Excludes `AGENTS.md`, `CLAUDE.md`, `README.md`, and `NODE_MODULES/`.
- Skips files larger than 1 MB or with empty content.
- Results are sorted alphabetically and **cached** after the first build.

---

## Workflow: `/loop` Deep Dive

### Evaluation Criteria

The reviewer evaluates submissions against eight criteria:

1. **Language & algorithms** — correct use of language features, algorithms, and data structures.
2. **Simplicity** — is the implementation no more complex than necessary? Every line is a liability.
3. **Structure** — elegant program structure, higher-order functions, clear separation of concerns.
4. **File & function size** — no oversized files, overly long functions, or spaghetti code.
5. **Testing** — are unit tests present? Are integration tests needed?
6. **Design & correctness** — design flaws, mathematical errors, logical contradictions, architecture issues.
7. **API usability** — from the caller's perspective: is the API intuitive and elegant?
8. **Requirements** — does it fully satisfy the requirements? No cutting corners.

### Flow Diagram

```
User: /loop Refactor the auth module to use JWT

  ┌─────────────────────────────────────────────────────────────────┐
  │  command.execute.before intercepts                              │
  │  → Sets session to review-gated mode                            │
  │  → Rewrites prompt with structured task instruction              │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  LLM works on the task                                          │
  │  (can use basher, editor, explorer, reverie, websearch, etc.)   │
  │                                                                  │
  │  ○ If session goes idle with open todos → nudge-todo fires       │
  │  ○ If session goes idle with no todos → loop nudge fires  │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  LLM calls submit_review({                                       │
  │    report: "...",                                                │
  │    affectedFiles: ["src/auth.ts", "src/auth.test.ts"]            │
  │  })                                                              │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  Reviewer sub-session spawned (based on explorer agent)          │
  │  → Gets REVIEW_INSTRUCTIONS + evaluation criteria                │
  │  → Can read files, use semblle, run read-only bash commands      │
  │  → Has submit_review_result tool                                 │
  │                                                                  │
  │  ┌─────────────────────────────────────────────────────────┐     │
  │  │  Reviewer reads affected files, analyzes changes         │     │
  │  │                                                          │     │
  │  │  ├─► submit_review_result({ feedback: null })  → ACCEPT  │     │
  │  │  └─► submit_review_result({ feedback: "..." }) → REJECT  │     │
  │  │                                                          │     │
  │  │  If reviewer ends without calling tool:                  │     │
  │  │  → Nudged up to 3 times                                 │     │
  │  │  → After 3 nudges, whatever text exists is used          │     │
  │  └─────────────────────────────────────────────────────────┘     │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  Review result returned to LLM:                                  │
  │                                                                  │
  │  If ACCEPTED: "Review passed. loop mode has ended."       │
  │                                                                  │
  │  If REJECTED: "Review feedback:\n...\nAddress the feedback       │
  │  above. loop mode has ended — you may continue normally." │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  loop mode ends (one-shot)                                │
  │  → Session is no longer review-gated                            │
  │  → LLM may continue working normally                            │
  └─────────────────────────────────────────────────────────────────┘
```

### Key Behaviors

- **One-shot:** The mode activates for exactly one review cycle. After the review resolves (accept or reject), the mode ends.
- **Todo priority:** The todo nudge runs before the review nudge. If there are incomplete todos, the review nudge is suppressed — the LLM must finish its task before submitting.
- **Reviewer nudging:** If the reviewer sub-session ends without calling `submit_review_result`, it is re-prompted up to 3 times. After 3 failed nudges, whatever text the reviewer produced is used as feedback.
- **Abort suppression:** After a session abort error, both nudges are suppressed for 5 seconds to avoid feedback loops.

---

## Architecture

### Subagent Delegation Pattern

The core architectural pattern is **subagent delegation via child sessions**. When the orchestrator calls a tool like `basher`, `editor`, or `explorer`, the tool:

1. Creates a **child session** via `client.session.create()`.
2. Sets the child session's agent (e.g., `basher`, `editor`, `explorer`).
3. Presents the request as a text prompt to the child session.
4. Waits for the child session to complete.
5. Extracts the assistant's response text via `client.session.messages()`.

```
┌──────────────────────────────────────────────────────────────────┐
│                    OpenCode Session                                │
│                                                                   │
│  ┌──────────────┐  basher("npm test")                             │
│  │ Orchestrator │────────────────────────────────────────────────┐│
│  │ (foreground) │                                                ││
│  │              │  editor("Refactor auth...")                     ││
│  │ basher  ✅   │──────────────────────────────────────────────┐ ││
│  │ editor  ✅   │                                              │ ││
│  │ explorer ✅  │  explorer("Find auth middleware...")          │ ││
│  │ bash    ❌   │────────────────────────────────────────────┐ │ ││
│  │ edit    ❌   │                                            │ │ ││
│  │ write   ❌   │  reverie("Design question...")             │ │ ││
│  │ glob    ❌   │──────────────────────────────────────────┐ │ │ ││
│  │ grep    ❌   │                                          │ │ │ ││
│  └──────────────┘  submit_review(...)                      │ │ │ ││
│       │            ──────────────────────────────────────┐ │ │ │ ││
│       │                                                  │ │ │ │ ││
│       │    ┌──────────────────┐  ┌──────────────────┐   │ │ │ │ ││
│       │    │ Child Session    │  │ Child Session    │   │ │ │ │ ││
│       │    │ Agent: basher    │  │ Agent: editor    │   │ │ │ │ ││
│       │    │ bash: allow      │  │ read/write/edit   │   │ │ │ │ ││
│       │    │ read/write: deny │  │ basher: yes       │   │ │ │ │ ││
│       │    └──────────────────┘  └──────────────────┘   │ │ │ │ ││
│       │                                                 │ │ │ │ ││
│       │    ┌──────────────────┐  ┌──────────────────┐   │ │ │ │ ││
│       │    │ Child Session    │  │ Child Session    │   │ │ │ │ ││
│       │    │ Agent: explorer  │  │ Agent: reverie   │   │ │ │ │ ││
│       │    │ semble: yes      │  │ tools: none      │   │ │ │ │ ││
│       │    │ read: allow      │  └──────────────────┘   │ │ │ │ ││
│       │    │ write: deny      │                         │ │ │ │ ││
│       │    └──────────────────┘                         │ │ │ │ ││
│       │                                                 │ │ │ │ ││
│       │    ┌────────────────────────────────────────────┘ │ │ │ ││
│       │    │ Child Session                                │ │ │ ││
│       │    │ Agent: explorer (reviewer)                   │ │ │ ││
│       │    │ tools: +submit_review_result                 │ │ │ ││
│       │    │ Evaluates against 8 criteria                 │ │ │ ││
│       │    └──────────────────────────────────────────────┘ │ │ ││
│       └──────────────────────────────────────────────────────┘ ││
└──────────────────────────────────────────────────────────────────┘
```

### Plugin Registration

The plugin entry point (`src/index.ts`) registers everything in a structured `Plugin` object:

```typescript
export default {
  name: 'caps-context',
  tool: { basher, editor, explorer, reverie, submit_review, submit_review_result, webfetch, websearch },
  config: (opencodeConfig) => { /* configure agents, permissions, commands */ },
  'experimental.chat.system.transform': /* CAPS context injection */,
  'tool.execute.before': /* bash timeout + pipe stripping */,
  'command.execute.before': /* /loop interception */,
  'event': /* nudge-todo + loop nudge */,
};
```

### Permissions Model

Each agent operates under strict permissions:

| Agent | bash | read | write | edit | glob | grep | semble | submit_review | submit_review_result |
|-------|------|------|-------|------|------|------|--------|---------------|---------------------|
| orchestrator | ❌ | ✅* | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| basher | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| editor | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| explorer | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| reviewer | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| reverie | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

*\* The orchestrator can read files indirectly via `explorer` and `editor` tools.*

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- Node.js ≥ 20 (for opencode)

### Installation

```bash
# Clone the repository
git clone <repo-url> oc-kunwei
cd oc-kunwei

# Install dependencies
bun install

# Set up API key for web search/fetch
cp src/ollama-web/key.ts.example src/ollama-web/key.ts
```

### API Key Configuration

Edit `src/ollama-web/key.ts` with your ollama.com API key:

```typescript
export const OLLAMA_API_KEY = 'sk-or-v1-your-api-key-here';
```

The API key is required for `websearch` and `webfetch` tools. If you do not need these tools, you can omit the key setup — the tools will return an error when called.

The `key.ts` file is git-ignored (listed in `.gitignore`) and will not be committed.

---

## Build & Test

```bash
# Bundle the plugin to dist/index.js
bun run build

# TypeScript type checking
bun run typecheck

# Run all tests (uses bun:test)
bun test src/

# Lint with Biome
bun run lint

# Format with Biome
bun run format

# Full check (lint + format + organize imports)
bun run check

# CI check (read-only — does not write changes)
bun run check:ci
```

### Test Structure

Tests are co-located with source files (`*.test.ts`). The test runner is `bun:test`:

| Test file | What it covers |
|-----------|----------------|
| `src/basher/index.test.ts` | `stripHeadTailPipes`, `enforceTimeout`, `getBasherConfig`, `createBasherTool` execution |
| `src/editor/index.test.ts` | `getEditorConfig`, `createEditorTool` delegation |
| `src/explorer/index.test.ts` | `getExplorerConfig`, `createExplorerTool` delegation, semble MCP presence |
| `src/reverie/index.test.ts` | Reverie tool configuration |
| `src/nudge-todo/index.test.ts` | Todo nudge event handling |
| `src/ollama-web/index.test.ts` | Web search/fetch tool configuration |
| `src/refer-caps/index.test.ts` | CAPS file discovery and context building |
| `src/loop/index.test.ts` | Review workflow, nudging, session management |

---

## Install in opencode

In your `opencode.jsonc` configuration file, add the plugin:

```jsonc
{
  "plugin": ["file:///path/to/oc-kunwei"]
}
```

Or if installed from a registry:

```jsonc
{
  "plugin": ["oc-kunwei"]
}
```

The plugin will automatically:
- Register all tools (`basher`, `editor`, `explorer`, `reverie`, `websearch`, `webfetch`, `submit_review`, `submit_review_result`).
- Configure all agents with their respective permissions.
- Disable `glob`, `grep`, and `task` tools on the orchestrator.
- Register the `/loop` command.
- Set up all hooks (bash timeout/pipe-stripping, command interception, nudge hooks, CAPS context injection).

### Verifying Installation

After adding the plugin and restarting opencode, you should see:

```
Plugin 'caps-context' loaded
  Registered tools: basher, editor, explorer, reverie, websearch, webfetch, submit_review, submit_review_result
  Registered command: /loop
```

---

## Project Structure

```
oc-kunwei/
├── dist/                          # Build output (bundled plugin)
│   └── index.js
├── src/                           # Source code
│   ├── index.ts                   # Plugin entry point — registers tools, hooks, agents, commands
│   │
│   ├── basher/                    # Shell execution via sub-session
│   │   ├── index.ts               # createBasherTool, stripHeadTailPipes, enforceTimeout, getBasherConfig
│   │   └── index.test.ts          # Unit tests for pipe stripping, timeout enforcement, tool execution
│   │
│   ├── editor/                    # File edit delegation via sub-session
│   │   ├── index.ts               # createEditorTool, getEditorConfig
│   │   └── index.test.ts          # Unit tests for editor delegation
│   │
│   ├── explorer/                  # Semantic code search via semble MCP
│   │   ├── index.ts               # createExplorerTool, getExplorerConfig
│   │   └── index.test.ts          # Unit tests for explorer delegation
│   │
│   ├── reverie/                   # Tool-free contemplation sub-session
│   │   ├── index.ts               # createReverieTool, getReverieConfig
│   │   └── index.test.ts          # Unit tests for reverie tool
│   │
│   ├── loop/               # /loop command + review workflow
│   │   ├── index.ts               # Command manager, submit_review, submit_review_result, reviewer nudge logic
│   │   └── index.test.ts          # Unit tests for review workflow
│   │
│   ├── nudge-todo/                # Auto-continue on idle when todos are incomplete
│   │   ├── index.ts               # createNudgeTodoHook — listens for session.idle events
│   │   └── index.test.ts          # Unit tests for nudge logic
│   │
│   ├── ollama-web/                # Web search/fetch via ollama.com API
│   │   ├── index.ts               # createOllamaWebSearchTool, createOllamaWebFetchTool
│   │   ├── index.test.ts          # Unit tests for web tool configurations
│   │   ├── key.ts.example         # Template for API key (copy to key.ts)
│   │   ├── key.ts                 # Your OLLAMA_API_KEY (git-ignored)
│   │
│   ├── refer-caps/                # Inject ALL_CAPS markdown files into system prompts
│   │   ├── index.ts               # findCapsFiles, buildCapitalsContext, createCapitalsContextHook
│   │   └── index.test.ts          # Unit tests for CAPS file discovery
│   │
│   └── utils/                     # Shared utilities
│       └── session.ts             # extractSessionText, getAbortSignal, promptWithAbort
│
├── biome.json                     # Biome configuration (linter, formatter)
├── tsconfig.json                  # TypeScript configuration
├── package.json                   # Dependencies, scripts, plugin metadata
├── bun.lock                       # Bun lockfile
├── .gitignore                     # Git ignore rules
└── README.md                      # This file
```

### Directory Details

| Directory | Purpose |
|-----------|---------|
| `src/basher/` | Shell execution with `timeout 1` enforcement, `\| head\|tail` pipe stripping, and natural-language output summarization via a dedicated basher agent. |
| `src/editor/` | File editing delegation. The editor subagent can read, write, and edit files, plus run verification commands via `basher`. |
| `src/explorer/` | Read-only code exploration using semble MCP for semantic search. Used as the base agent for the reviewer. |
| `src/reverie/` | Pure text thinking — creates a sub-session with no tools and a minimal system prompt focused on deep contemplation. |
| `src/loop/` | The complete review-gated workflow: command interception, `submit_review` tool, `submit_review_result` tool, reviewer nudge logic (up to 3 nudges), and session state management. |
| `src/nudge-todo/` | Idle detection hook that prompts the LLM to continue working when there are incomplete todos. |
| `src/ollama-web/` | Web search (`websearch`) and URL fetch (`webfetch`) tools backed by the ollama.com API. Requires an API key. |
| `src/refer-caps/` | System prompt augmentation: discovers `*_CAPS.md` files and `*_CAPS/` directories at the project root and injects their contents into the system prompt. Results are cached after first build. |
| `src/utils/` | Shared utilities for session management: extracting assistant text from child sessions, handling abort signals, and racing prompts against abort signals. |

---

## Contributing

### Development Workflow

1. **Fork** the repository.
2. **Create a feature branch:** `git checkout -b feat/my-feature`.
3. **Make changes** in `src/`.
4. **Write tests** for new functionality. Tests use `bun:test` and are co-located with source files.
5. **Run checks:**
   ```bash
   bun run typecheck   # TypeScript type safety
   bun test src/       # All tests pass
   bun run check       # Biome lint + format
   ```
6. **Commit** using conventional commit messages:
   - `feat:` — new feature
   - `fix:` — bug fix
   - `refactor:` — code restructuring
   - `test:` — adding or updating tests
   - `docs:` — documentation
   - `chore:` — build, CI, tooling
7. **Push** and open a Pull Request.

### Code Style

- **Language:** TypeScript with strict mode enabled.
- **Formatting:** Biome with 2-space indentation, single quotes, trailing commas.
- **Line width:** 80 characters.
- **No `any`** — except in tests (where `noExplicitAny` is relaxed).
- **No side effects at module level** — all initialization happens in the plugin factory function.

### Adding a New Tool

1. Create a new directory under `src/` (e.g., `src/my-tool/`).
2. Export a `createMyTool(ctx)` function returning a `ToolDefinition`.
3. Register the tool in `src/index.ts` under the `tool:` section.
4. If the tool needs a dedicated agent, implement `getMyConfig()` and register agents in the `config:` callback.
5. Add tests in `src/my-tool/index.test.ts`.

### Testing Guidelines

- Use `bun:test` (`describe`, `test`, `expect`, `mock`).
- Mock `client` objects to avoid real API calls.
- Test both success paths and error handling.
- Keep tests fast — they should not require network access.

### Before Submitting

- [ ] `bun run typecheck` passes with no errors.
- [ ] `bun test src/` passes all tests.
- [ ] `bun run check` produces no warnings or errors.
- [ ] New code includes tests.
- [ ] Commit messages follow conventional format.

---

## License

[MIT](LICENSE) — feel free to use, modify, and distribute.
