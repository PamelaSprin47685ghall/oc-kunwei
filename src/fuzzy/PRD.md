# Fuzzy Search — 设计文档

## 用途

将 [@ff-labs/fff-node](https://www.npmjs.com/package/@ff-labs/fff-node) 的模糊搜索能力注册为 `fuzzy_find` / `fuzzy_grep` 插件工具。FFF 提供 frecency 排序、git 感知、SIMD 加速的模糊搜索。

## 工具注册

| 工具名 | 工厂函数 | 说明 |
|--------|----------|------|
| `fuzzy_find` | `createFuzzyFindTool()` | 模糊文件路径搜索，替代内置 `glob` |
| `fuzzy_grep` | `createFuzzyGrepTool()` | 模糊文件内容搜索，替代内置 `grep` |

内置 `glob` 仅对 editor / greper / orchestrator 开放；内置 `grep` 对所有 agent 关闭。

## 数据流

```
工具调用 → createFuzzyFindTool / createFuzzyGrepTool
                 ↓
           FinderManager.get(cwd)
                 ↓
           FileFinder.create({ basePath: cwd, aiMode: true })
                 ↓
           fileSearch() / grep()
                 ↓
           formatFindOutput / formatGrepOutput
                 ↓
           返回文本结果（末尾含 iterator=... 续传标记）
```

## 分页

使用单次消费的 iterator 模式，替代旧版 cursor store：

- 首次调用返回 `iterator="..."`，二次调用只需传 `iterator`
- iterator 消费一次即失效
- 结果末尾 `iterator=""` 表示无更多数据

## 零配置

FFF 始终启用。`@ff-labs/fff-node` 不可用时静默降级，工具返回错误提示。

## 外部绝对路径

绝对路径绕过 `FinderManager` 缓存，即时创建临时 `FileFinder`，调用完毕后立即销毁。

## 文件结构

```
src/fuzzy/
├── index.ts        # 工厂函数，使用 @opencode-ai/plugin tool API
├── finder.ts       # FinderManager — 惰性 FileFinder 管理
├── format.ts       # 格式化输出 + IteratorStore 分页
├── query.ts        # 查询构建（路径约束、排除规则）
├── index.test.ts   # 测试
└── PRD.md          # 本文档
```
