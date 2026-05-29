# oc-kunwei

[![Plugin version](https://img.shields.io/badge/version-0.1.0-blue)](https://opencode.ai)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)](https://opencode.ai)
[![Bun](https://img.shields.io/badge/Bun-≥1.3-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org)

**kunwei** 是一个 [opencode](https://opencode.ai) 插件，提供一套精选工具、专用子代理（subagent）和工作流命令，用于结构化、循环门控（loop-gated）的开发流程。它实现了**最小权限子代理委派**架构——编排器（orchestrator）从不直接操作文件或执行命令，所有工作都委派给拥有最小权限的专用子代理完成。

---

## 为什么选择 oc-kunwei？

### 🛡️ 最小权限子代理委派

编排器代理（主 LLM 会话）被剥夺了所有危险能力——没有 `bash`、`edit`、`write`、`glob`、`grep`。取而代之的是，它通过专用子会话将每个操作委派给专门的子代理：

| 子代理 | 可执行操作 | 不可执行操作 |
|----------|--------|-----------|
| **basher** | 运行 bash 命令（带 `timeout 5`） | 读/写文件、编辑代码 |
| **editor** | 读、写、编辑文件 + 运行 bash | 访问 semblle、web 或 review 工具 |
| **explorer** | 读取文件 + semblle 语义搜索 + bash | 写入或编辑任何文件 |
| **reverie** | 纯文本思考——无任何工具 | 使用任何工具 |

这意味着编排器只能进行编排。它必须明确选择调用哪个子代理，使每个操作都经过深思熟虑且可审计。

### ✅ 循环门控开发（Loop-Gated Development）

`/loop` 命令激活一次性循环门控（one-shot loop gate）：LLM 处理任务，通过 `submit_review` 提交报告，专用的审查员代理（沙箱化在 explorer 代理中）根据八条严格标准评估工作。结果为**通过**（`feedback` 为 `null`）或**拒绝**（附带具体的可操作反馈）。

### 📄 通过 CAPS 文件注入上下文

`experimental.chat.system.transform` 钩子自动发现项目根目录下的 `*_CAPS.md` 文件（或 `*_CAPS/` 目录内的文件），并将其内容注入系统提示词。这允许团队将项目级约定、架构指南或 API 契约定义为纯 Markdown 文件，这些文件始终存在于 LLM 的上下文中——而无需污染单个提示词。

---

## 工具

### `basher`

通过专用的 basher 子会话执行 Shell 命令。编排器不能直接运行 bash——必须通过此工具。

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `command` | `string` | ✅ | 要执行的 bash 命令。**不要**手动包裹 `timeout(5)`——系统会自动添加。 |
| `what_to_summarize` | `string` | ✅ | 描述在输出中需要关注的内容。请具体说明，以便获得精准的自然语言总结。 |

该工具：
1. 去除 `| head -n N` / `| tail -N` 管道（这些是常见的 LLM 产物，会干扰命令输出）。
2. 将命令包裹为 `timeout 5 bash -c '...'`，强制 5 秒硬限制。
3. 启动一个 **basher** 子代理子会话。
4. 返回自然语言总结，而非原始输出。

> **限制：** 编排器被禁止使用 `bash` 内置工具。所有 Shell 执行必须通过 `basher`。

---

### `editor`

将代码编辑任务委派给专用的 editor 子代理。

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `task` | `string` | ✅ | 编辑任务的详细描述——包括文件路径、具体变更和相关上下文。 |

editor 子代理可以：
- 读取文件（`read`）
- 写入新文件（`write`）
- 编辑已有文件（`edit`）
- 通过 `basher` 运行命令（例如 `npm test`、`bun run build`）

它**不能**使用 Web 搜索、semble 或 review 工具。

---

### `explorer`

使用 semblle MCP 执行语义代码搜索和只读探索。

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `query` | `string` | ✅ | 描述要查找代码的自然语言搜索查询（例如"认证中间件在哪里定义？"）。 |

explorer 子代理拥有：
- `read` 权限（可读取文件内容）
- `basher` 工具用于只读命令（列出文件、git status 等）
- **semble** MCP 用于语义代码搜索
- `write` 和 `edit` 被**拒绝**——不能修改文件

> **注意：** explorer 的系统提示词明确警告不要使用 `basher` 修改文件。如需修改，必须报告而非直接操作。

---

### `reverie`

一个无工具的沉思子会话，用于深度思考。没有命令、没有搜索、没有文件访问——只有问题和提供的文件。

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `question` | `string` | ✅ | 需要深思的问题。越难越好。 |
| `files` | `string[]` | ✅ | 作为上下文提供的文件路径。系统会读取文件内容并将其嵌入提示词。 |

reverie 代理**没有任何工具**。其系统提示词设定了场景：*"没有工具，没有干扰——只有你和问题。"* 适用于设计决策、Bug 分析、代码审查准备或任何受益于无干扰推理的场景。

---

### `websearch`

通过 ollama.com API 搜索 Web。

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `query` | `string` | ✅ | 自然语言搜索查询。请描述理想页面，而非关键词。 |
| `numResults` | `number` | ❌ | 返回的搜索结果数量（默认：`10`）。 |

**查询技巧：**
- `"blog post comparing React and Vue performance"` ——而非 `"React vs Vue"`
- `"category:people John Doe"` ——搜索 LinkedIn 个人资料
- `"category:company Acme Corp"` ——搜索公司

---

### `webfetch`

通过 ollama.com API 获取 URL 并进行智能内容提取。

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `url` | `string` | ✅ | 要获取的 URL（仅支持 http: 和 https:）。 |
| `extract_main` | `boolean` | ❌ | 提取主要内容，移除导航和广告（默认：`true`）。 |
| `prefer_llms_txt` | `"auto"` \| `"always"` \| `"never"` | ❌ | 在获取完整页面前探测 `llms.txt` 文件（默认：`auto`）。 |
| `prompt` | `string` | ❌ | 可选的提取任务，由廉价辅助模型处理。 |
| `timeout` | `number` | ❌ | 超时秒数（最大：`120`）。 |

返回：标题、作者行、内容长度和提取的内容。

---

### `submit_review`

提交工作以供审查。**仅在 `/loop` 模式下可用。**

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `report` | `string` | ✅ | 已完成工作及其理由的详细报告。 |
| `affectedFiles` | `string[]` | ✅ | 修改或创建的每个文件的路径列表。 |

调用后，会生成一个审查员子会话（使用 explorer 代理，并额外添加 `submit_review_result` 工具）。审查员评估工作并提交判决。

---

### `submit_review_result`

审查员提交判决的工具。**仅对审查员子会话可用。**

| 参数 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `feedback` | `string` \| `null` | ✅ | `null` = **通过**。非 null 字符串 = **拒绝**并附带具体的可操作反馈。 |

> **重要：** 如果通过，`feedback` 必须精确为 `null`。任何文本——包括赞美——都将被视为拒绝反馈。

---

## 命令

| 命令 | 描述 |
|---------|-------------|
| **`/loop <task>`** | 激活一次性循环门控模式。将任务重写为结构化提示词，指示 LLM 完成任务后调用 `submit_review`。审查完成后模式结束。 |

---

## 代理

### 编排器（前台 Orchestrator）

- **可用工具：** `basher`、`editor`、`explorer`
- **明确禁止：** `bash`、`edit`、`write`、`glob`、`grep`
- **semble 权限：** `deny`（不能直接使用 semblle——必须通过 `explorer`）
- **目的：** 主会话代理。通过委派给子代理来编排工作。可以思考、计划和调用专用工具，但不能接触文件或直接运行 Shell 命令。

### basher（子代理）

- **模式：** `subagent`
- **工具：** 仅 `bash`
- **权限：** `*: deny`、`bash: allow`
- **semble 权限：** `deny`
- **系统提示词：** 精通分析终端输出的专家。返回自然语言总结。
- **目的：** 执行 Shell 命令，强制 `timeout 5` 并去除管道。以自然语言总结输出。

### editor（子代理）

- **模式：** `subagent`
- **工具：** 明确启用 `basher`
- **权限：** `*: deny`、`read: allow`、`write: allow`、`edit: allow`
- **semble 权限：** `deny`
- **系统提示词：** 代码编辑助手——读取文件、编辑文件、写入新文件、运行命令。
- **目的：** 执行文件修改。可以读取、编辑、写入文件并运行验证命令。

### explorer（子代理）

- **模式：** `subagent`
- **工具：** 明确启用 `basher`
- **权限：** `*: deny`、`read: allow`
- **semble 权限：** `allow`（唯一拥有 semble 访问权限的代理）
- **MCP：** `semble`
- **系统提示词：** 代码探索代理。使用 semble 进行语义搜索。读取文件以获取上下文。**明确警告不要修改文件。**
- **目的：** 只读代码探索和语义搜索。用作审查员代理的基础。

### reverie（子代理）

- **模式：** `subagent`
- **工具：** *（无）*
- **权限：** 未授予任何权限
- **系统提示词：** 安静沉思——没有工具，没有干扰。
- **目的：** 纯文本深度思考。没有任何可用工具。

### 审查员（复用 explorer）

- **模式：** subagent（动态生成）
- **基础代理：** `explorer`（继承其所有工具和权限）
- **额外工具：** `submit_review_result`
- **系统提示词：** 严格的代码审查员，拥有八条评估标准（见工作流一节）。
- **目的：** 审查提交的工作并返回结构化判决。如果未调用 `submit_review_result` 而结束，最多被提示 3 次。

---

## 钩子（Hooks）

### `tool.execute.before`（bash 拦截）

| 触发条件 | 操作 |
|---------|--------|
| 任何 `bash` 工具的执行 | 1. 去除 `\| head\|tail` 管道（常见的 LLM 幻觉产物）。2. 将命令包裹为 `timeout 5 bash -c '...'`，强制 5 秒硬限制。 |

此钩子在每次 `bash` 调用时运行，包括来自子代理的调用。管道去除逻辑是递归的——多个管道都会被移除，每次移除都会被记录用于诊断。

### `command.execute.before`（`/loop` 拦截）

| 触发条件 | 操作 |
|---------|--------|
| 用户输入 `/loop <task>` | 拦截命令，将会话标记为循环门控模式，将提示词重写为结构化指令："完成任务，然后调用 `submit_review`，附带报告和受影响的文件列表。审查员将检查你的提交。" |

命令注册在 `opencodeConfig` 中，将 `/loop` 设置为带有描述和模板的正式 opencode 命令。

### `event`（session.idle——提示钩子）

两个独立的提示钩子在空闲事件时运行：

| 钩子 | 条件 | 操作 |
|------|-----------|--------|
| **nudge-todo** | 会话空闲且存在未完成的 todo（未标记为 `completed` 或 `cancelled`） | 提示 LLM：*"还有未完成的 todo。请继续处理剩余项。"* |
| **loop nudge** | 会话空闲且处于 `/loop` 模式且**没有**未关闭的 todo（todo 优先） | 提示 LLM：*"你必须在结束前调用 `submit_review`。"* |

循环提示仅在 todo 全部完成后运行——未完成的 todo 会抑制审查提示。两个钩子在中止错误后都有 5 秒的抑制窗口。

### `experimental.chat.system.transform`（CAPS 上下文注入）

| 触发条件 | 操作 |
|---------|--------|
| 每次聊天初始化 | 发现项目根目录下所有 `*_CAPS.md` 文件（或 `*_CAPS/` 目录内的文件），读取其内容，并将其追加到系统提示词中，包裹在 `<caps-context>` 标签内。 |

**文件发现规则：**
- 匹配项目根目录下符合 `^[A-Z][A-Z0-9_]*\.md$` 的文件。
- 同时递归扫描符合 `^[A-Z][A-Z0-9_]*$` 目录下的所有文件。
- 排除 `AGENTS.md`、`CLAUDE.md`、`README.md` 和 `NODE_MODULES/`。
- 跳过大于 1 MB 或内容为空的文件。
- 结果按字母顺序排序，首次构建后**缓存**。

---

## 工作流：`/loop` 深度解析

### 评估标准

审查员根据八条标准评估提交：

1. **语言与算法**——正确使用语言特性、算法和数据结构。
2. **简洁性**——实现是否比必要更复杂？每一行代码都是潜在风险。
3. **结构**——优雅的程序结构、高阶函数、清晰的关注点分离。
4. **文件与函数大小**——没有过大的文件、过长的函数或意大利面条式代码。
5. **测试**——是否存在单元测试？是否需要集成测试？
6. **设计与正确性**——设计缺陷、数学错误、逻辑矛盾、架构问题。
7. **API 易用性**——从调用者角度看：API 是否直观且优雅？
8. **需求满足**——是否完全满足需求？没有偷工减料。

### 流程图示

```
用户：/loop 使用 JWT 重构认证模块

  ┌─────────────────────────────────────────────────────────────────┐
  │  command.execute.before 拦截                                      │
  │  → 将会话设置为循环门控模式                                        │
  │  → 使用结构化任务指令重写提示词                                      │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  LLM 处理任务                                                     │
  │  （可使用 basher、editor、explorer、reverie、websearch 等）          │
  │                                                                  │
  │  ○ 如果会话在有待办 todo 时空闲 → nudge-todo 触发                   │
  │  ○ 如果会话在无待办 todo 时空闲 → loop nudge 触发                   │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  LLM 调用 submit_review({                                         │
  │    report: "...",                                                  │
  │    affectedFiles: ["src/auth.ts", "src/auth.test.ts"]              │
  │  })                                                                │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ 审查员子会话生成（基于 explorer 代理）                              │
  │  → 获取 REVIEW_INSTRUCTIONS + 评估标准                             │
  │  → 可读取文件、使用 semblle、运行只读 bash 命令                      │
  │  → 拥有 submit_review_result 工具                                  │
  │                                                                  │
  │  ┌─────────────────────────────────────────────────────────┐     │
  │  │ 审查员读取受影响的文件，分析变更                            │     │
  │  │                                                          │     │
  │  │  ├─► submit_review_result({ feedback: null })  → 通过     │     │
  │  │  └─► submit_review_result({ feedback: "..." }) → 拒绝     │     │
  │  │                                                          │     │
  │  │ 如果审查员未调用工具就结束：                                 │     │
  │  │  → 最多提示 3 次                                          │     │
  │  │  → 3 次提示后，使用审查员产生的文本作为反馈                  │     │
  │  └─────────────────────────────────────────────────────────┘     │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ 审查结果返回给 LLM：                                              │
  │                                                                  │
  │ 如果通过： "审查通过。loop 模式已结束。"                            │
  │                                                                  │
  │ 如果拒绝： "审查反馈：\n...\n请处理上述反馈。                        │
  │ loop 模式已结束——你可以继续正常对话。"                            │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ loop 模式结束（一次性）                                            │
  │  → 会话不再处于循环门控状态                                        │
  │  → LLM 可以继续正常工作                                           │
  └─────────────────────────────────────────────────────────────────┘
```

### 关键行为

- **一次性：** 模式仅激活一个审查周期。审查解决（通过或拒绝）后，模式即结束。
- **Todo 优先级：** todo 提示在审查提示之前触发。如有未完成的 todo，审查提示被抑制——LLM 必须先完成任务再提交。
- **审查员提示：** 如果审查员子会话未调用 `submit_review_result` 就结束，系统会重新提示最多 3 次。3 次提示失败后，审查员产生的文本将作为反馈。
- **中止抑制：** 会话中止错误后，两个提示钩子被抑制 5 秒，避免反馈循环。

---

## 架构

### 子代理委派模式

核心架构模式是**通过子会话进行子代理委派**。当编排器调用 `basher`、`editor` 或 `explorer` 等工具时：

1. 通过 `client.session.create()` 创建**子会话**。
2. 将子会话的代理设置为目标代理（例如 `basher`、`editor`、`explorer`）。
3. 以文本提示词形式向子会话提交请求。
4. 等待子会话完成。
5. 通过 `client.session.messages()` 提取助手的响应文本。

```
┌──────────────────────────────────────────────────────────────────┐
│                    OpenCode 会话                                   │
│                                                                   │
│  ┌──────────────┐  basher("npm test")                             │
│  │ 编排器         │────────────────────────────────────────────────┐│
│  │（前台）        │                                                ││
│  │              │  editor("重构认证模块...")                       ││
│  │ basher  ✅   │──────────────────────────────────────────────┐ ││
│  │ editor  ✅   │                                              │ ││
│  │ explorer ✅  │  explorer("查找认证中间件...")               │ ││
│  │ bash    ❌   │────────────────────────────────────────────┐ │ ││
│  │ edit    ❌   │                                            │ │ ││
│  │ write   ❌   │  reverie("设计问题...")                    │ │ ││
│  │ glob    ❌   │──────────────────────────────────────────┐ │ │ ││
│  │ grep    ❌   │                                          │ │ │ ││
│  └──────────────┘  submit_review(...)                      │ │ │ ││
│       │            ──────────────────────────────────────┐ │ │ │ ││
│       │                                                  │ │ │ │ ││
│       │    ┌──────────────────┐  ┌──────────────────┐   │ │ │ │ ││
│       │    │ 子会话           │  │ 子会话           │   │ │ │ │ ││
│       │    │ 代理: basher     │  │ 代理: editor     │   │ │ │ │ ││
│       │    │ bash: allow      │  │ read/write/edit   │   │ │ │ │ ││
│       │    │ read/write: deny │  │ basher: yes       │   │ │ │ │ ││
│       │    └──────────────────┘  └──────────────────┘   │ │ │ │ ││
│       │                                                 │ │ │ │ ││
│       │    ┌──────────────────┐  ┌──────────────────┐   │ │ │ │ ││
│       │    │ 子会话           │  │ 子会话           │   │ │ │ │ ││
│       │    │ 代理: explorer   │  │ 代理: reverie    │   │ │ │ │ ││
│       │    │ semble: yes      │  │ tools: none      │   │ │ │ │ ││
│       │    │ read: allow      │  └──────────────────┘   │ │ │ │ ││
│       │    │ write: deny      │                         │ │ │ │ ││
│       │    └──────────────────┘                         │ │ │ │ ││
│       │                                                 │ │ │ │ ││
│       │    ┌────────────────────────────────────────────┘ │ │ │ ││
│       │    │ 子会话                                       │ │ │ ││
│       │    │ 代理: explorer（审查员）                      │ │ │ ││
│       │    │ 工具: +submit_review_result                  │ │ │ ││
│       │    │ 根据 8 条标准评估                             │ │ │ ││
│       │    └──────────────────────────────────────────────┘ │ │ ││
│       └──────────────────────────────────────────────────────┘ ││
└──────────────────────────────────────────────────────────────────┘
```

### 插件注册

插件入口点（`src/index.ts`）将所有内容注册到结构化的 `Plugin` 对象中：

```typescript
export default {
  name: 'kunwei',
  tool: { basher, editor, explorer, reverie, submit_review, submit_review_result, webfetch, websearch },
  config: (opencodeConfig) => { /* 配置代理、权限、命令 */ },
  'experimental.chat.system.transform': /* CAPS 上下文注入 */,
  'tool.execute.before': /* bash 超时 + 管道去除 */,
  'command.execute.before': /* /loop 拦截 */,
  'event': /* nudge-todo + loop nudge */,
};
```

### 权限模型

每个代理在严格权限下运行：

| 代理 | bash | read | write | edit | glob | grep | semble | submit_review | submit_review_result |
|-------|------|------|-------|------|------|------|--------|---------------|---------------------|
| orchestrator | ❌ | ✅* | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| basher | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| editor | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| explorer | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| reviewer | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| reverie | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

*\* 编排器可以通过 `explorer` 和 `editor` 工具间接读取文件。*

---

## 安装

### 前置条件

- [Bun](https://bun.sh) ≥ 1.3
- Node.js ≥ 20（用于 opencode）

### 安装步骤

```bash
# 克隆仓库
git clone <repo-url> oc-kunwei
cd oc-kunwei

# 安装依赖
bun install

# 设置 Web 搜索/抓取的 API 密钥
cp src/ollama-web/key.ts.example src/ollama-web/key.ts
```

### API 密钥配置

编辑 `src/ollama-web/key.ts`，填入你的 ollama.com API 密钥：

```typescript
export const OLLAMA_API_KEY = 'sk-or-v1-your-api-key-here';
```

`websearch` 和 `webfetch` 工具需要 API 密钥。如果不需要这些工具，可以跳过密钥配置——调用工具时会返回错误。

`key.ts` 文件被 git 忽略（已在 `.gitignore` 中列出），不会被提交。

---

## 构建与测试

```bash
# 将插件打包到 dist/index.js
bun run build

# TypeScript 类型检查
bun run typecheck

# 运行所有测试（使用 bun:test）
bun test src/

# 使用 Biome 进行代码检查
bun run lint

# 使用 Biome 格式化代码
bun run format

# 完整检查（lint + format + 组织导入）
bun run check

# CI 检查（只读——不写入更改）
bun run check:ci
```

### 测试结构

测试与源文件放在同一目录（`*.test.ts`）。测试运行器为 `bun:test`：

| 测试文件 | 覆盖内容 |
|-----------|----------------|
| `src/basher/index.test.ts` | `stripHeadTailPipes`、`enforceTimeout`、`getBasherConfig`、`createBasherTool` 执行 |
| `src/editor/index.test.ts` | `getEditorConfig`、`createEditorTool` 委派 |
| `src/explorer/index.test.ts` | `getExplorerConfig`、`createExplorerTool` 委派、semble MCP 存在性 |
| `src/reverie/index.test.ts` | Reverie 工具配置 |
| `src/nudge-todo/index.test.ts` | Todo 提示事件处理 |
| `src/ollama-web/index.test.ts` | Web 搜索/抓取工具配置 |
| `src/inject-caps/index.test.ts` | CAPS 文件发现和上下文构建 |
| `src/loop/index.test.ts` | 审查工作流、提示、会话管理 |

---

## 在 opencode 中安装

在 `opencode.jsonc` 配置文件中添加插件：

```jsonc
{
  "plugin": ["file:///path/to/oc-kunwei"]
}
```

或从注册表安装：

```jsonc
{
  "plugin": ["oc-kunwei"]
}
```

插件将自动：
- 注册所有工具（`basher`、`editor`、`explorer`、`reverie`、`websearch`、`webfetch`、`submit_review`、`submit_review_result`）。
- 为所有代理配置相应的权限。
- 在编排器上禁用 `glob`、`grep` 和 `task` 工具。
- 注册 `/loop` 命令。
- 设置所有钩子（bash 超时/管道去除、命令拦截、提示钩子、CAPS 上下文注入）。

### 验证安装

添加插件并重启 opencode 后，应看到：

```
Plugin 'kunwei' loaded
  Registered tools: basher, editor, explorer, reverie, websearch, webfetch, submit_review, submit_review_result
  Registered command: /loop
```

---

## 项目结构

```
oc-kunwei/
├── dist/                          # 构建输出（打包后的插件）
│   └── index.js
├── src/                           # 源代码
│   ├── index.ts                   # 插件入口点——注册工具、钩子、代理、命令
│   │
│   ├── basher/                    # 通过子会话执行 Shell 命令
│   │   ├── index.ts               # createBasherTool、stripHeadTailPipes、enforceTimeout、getBasherConfig
│   │   └── index.test.ts          # 管道去除、超时强制、工具执行的单元测试
│   │
│   ├── editor/                    # 通过子会话委派文件编辑
│   │   ├── index.ts               # createEditorTool、getEditorConfig
│   │   └── index.test.ts          # editor 委派的单元测试
│   │
│   ├── explorer/                  # 通过 semble MCP 进行语义代码搜索
│   │   ├── index.ts               # createExplorerTool、getExplorerConfig
│   │   └── index.test.ts          # explorer 委派的单元测试
│   │
│   ├── reverie/                   # 无工具的沉思子会话
│   │   ├── index.ts               # createReverieTool、getReverieConfig
│   │   └── index.test.ts          # reverie 工具的单元测试
│   │
│   ├── loop/                      # /loop 命令 + 审查工作流
│   │   ├── index.ts               # 命令管理器、submit_review、submit_review_result、审查员提示逻辑
│   │   └── index.test.ts          # 审查工作流的单元测试
│   │
│   ├── nudge-todo/                # 空闲时自动继续（如有未完成的 todo）
│   │   ├── index.ts               # createNudgeTodoHook——监听 session.idle 事件
│   │   └── index.test.ts          # 提示逻辑的单元测试
│   │
│   ├── ollama-web/                # 通过 ollama.com API 进行 Web 搜索/抓取
│   │   ├── index.ts               # createOllamaWebSearchTool、createOllamaWebFetchTool
│   │   ├── index.test.ts          # Web 工具配置的单元测试
│   │   ├── key.ts.example         # API 密钥模板（复制为 key.ts）
│   │   ├── key.ts                 # 你的 OLLAMA_API_KEY（被 git 忽略）
│   │
│   ├── inject-caps/               # 将 ALL_CAPS Markdown 文件注入系统提示词
│   │   ├── index.ts               # findCapsFiles、buildCapitalsContext、createCapitalsContextHook
│   │   └── index.test.ts          # CAPS 文件发现的单元测试
│   │
│   └── utils/                     # 共享工具
│       └── session.ts             # extractSessionText、getAbortSignal、promptWithAbort
│
├── biome.json                     # Biome 配置（代码检查器、格式化工具）
├── tsconfig.json                  # TypeScript 配置
├── package.json                   # 依赖、脚本、插件元数据
├── bun.lock                       # Bun 锁文件
├── .gitignore                     # Git 忽略规则
└── README.md                      # 本文档
```

### 目录详情

| 目录 | 用途 |
|-----------|---------|
| `src/basher/` | Shell 执行，带 `timeout 5` 强制限制、`\| head\|tail` 管道去除，以及通过专用 basher 代理进行的自然语言输出总结。 |
| `src/editor/` | 文件编辑委派。editor 子代理可以读取、写入和编辑文件，还可通过 `basher` 运行验证命令。 |
| `src/explorer/` | 只读代码探索，使用 semble MCP 进行语义搜索。用作审查员的基础代理。 |
| `src/reverie/` | 纯文本思考——创建一个无工具、系统提示词极简的子会话，专注于深度沉思。 |
| `src/loop/` | 完整的循环门控工作流：命令拦截、`submit_review` 工具、`submit_review_result` 工具、审查员提示逻辑（最多 3 次提示）和会话状态管理。 |
| `src/nudge-todo/` | 空闲检测钩子，当存在未完成的 todo 时提示 LLM 继续工作。 |
| `src/ollama-web/` | 基于 ollama.com API 的 Web 搜索（`websearch`）和 URL 抓取（`webfetch`）工具。需要 API 密钥。 |
| `src/inject-caps/` | 系统提示词增强：发现项目根目录下的 `*_CAPS.md` 文件和 `*_CAPS/` 目录，将其内容注入系统提示词。首次构建后缓存结果。 |
| `src/utils/` | 会话管理的共享工具：从子会话提取助手文本、处理中止信号、在提示词和中止信号间竞争。 |

---

## 贡献

### 开发工作流

1. **Fork** 仓库。
2. **创建特性分支：** `git checkout -b feat/my-feature`。
3. 在 `src/` 中**进行更改**。
4. 为新功能**编写测试**。测试使用 `bun:test`，与源文件放在同一目录。
5. **运行检查：**
   ```bash
   bun run typecheck   # TypeScript 类型安全
   bun test src/       # 所有测试通过
   bun run check       # Biome 代码检查 + 格式化
   ```
6. 使用约定式提交消息**提交**：
   - `feat:` ——新功能
   - `fix:` ——Bug 修复
   - `refactor:` ——代码重构
   - `test:` ——添加或更新测试
   - `docs:` ——文档
   - `chore:` ——构建、CI、工具
7. **推送**并发起 Pull Request。

### 代码风格

- **语言：** TypeScript，启用严格模式。
- **格式化：** Biome，2 空格缩进，单引号，尾随逗号。
- **行宽：** 80 字符。
- **禁止使用 `any`** ——测试除外（其中 `noExplicitAny` 宽松）。
- **模块级无副作用** ——所有初始化在插件工厂函数中完成。

### 添加新工具

1. 在 `src/` 下创建新目录（例如 `src/my-tool/`）。
2. 导出返回 `ToolDefinition` 的 `createMyTool(ctx)` 函数。
3. 在 `src/index.ts` 的 `tool:` 部分注册该工具。
4. 如果工具需要专用代理，实现 `getMyConfig()` 并在 `config:` 回调中注册代理。
5. 在 `src/my-tool/index.test.ts` 中添加测试。

### 测试指南

- 使用 `bun:test`（`describe`、`test`、`expect`、`mock`）。
- 模拟 `client` 对象，避免真实的 API 调用。
- 同时测试成功路径和错误处理。
- 保持测试快速——不应需要网络访问。

### 提交前检查

- [ ] `bun run typecheck` 无错误通过。
- [ ] `bun test src/` 所有测试通过。
- [ ] `bun run check` 无警告或错误。
- [ ] 新代码包含测试。
- [ ] 提交消息遵循约定式格式。

---

## 许可证

[MIT](LICENSE) —— 欢迎自由使用、修改和分发。
