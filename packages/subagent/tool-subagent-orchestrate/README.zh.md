# @deepseek-ai/dsh-tool-subagent-orchestrate

[English](README.md) | 中文

基于 `ctx.subagents`、面向模型的 `orchestrate` 工具：调用方 agent（智能体）在一次调用内将一个任务拆分为子任务，本包以并行的一次性委派执行它们，每个已结算结果都会返回给调用方以供复核与整合。它可与任意已注册的提供方组合，因此一次扇出可在同一张图中横跨进程内子 agent（`spawn`、`fork`）与进程外后端（`claude-code` 对应 Claude 模型、`codex` 对应 ChatGPT 模型、`acp` 对应 OpenCode 及其他 ACP agent）。

## 分治、调度与复核

模型在调用参数中编写子任务图；每项包含完整的独立提示词，以及可选的 `provider`、`model`、`effort` 和 `depends_on` 依赖边。校验会在启动任何子 agent 之前拒绝空图或超限图、重复或空标识、未知或自依赖以及环。

调度按依赖有序且无层级屏障：每个依赖已完成的子任务会立即启动，受 `maxConcurrency` 并发上限约束。失败的子任务仅会传递性地跳过其依赖者；独立分支会正常完成并上报。取消会跳过待处理子任务，而运行中的子级则通过各自的信号自行结算。

规范结果为每个子任务一行——按提交顺序给出状态、路由、最终文本、终止原因、诊断或跳过原因。渲染后的 transcript（文本记录）以计数标题行开头，并为每个结果提供一个带状态标签的小节，便于父级复核、整合正确成果、自行修复薄弱部分，或用更精确提示词重新委派。被跳过的行是仍待完成的工作。

## 路由：提供方、模型与推理强度

未显式覆盖的子任务使用实例配置的默认路由。显式的 `provider` 命名任意已注册的 `ctx.subagents` 提供方，这正是单次扇出可混合多供应商的方式：DeepSeek 走进程内提供方及其 LLM（大语言模型）适配器，Claude 走 `claude-code`，ChatGPT 走 `codex`，OpenCode 走 `acp`。`model` 覆盖经由 `agentOptions.model` 传递，由进程内提供方生效；进程外后端保持各自的部署配置模型。`effort` 覆盖通过该 seam 的 `reasoningEffort` 请求字段固定子 agent 的推理强度，并要求对应提供方的能力——目前仅进程内提供方声明该能力，因此在 `claude-code`、`codex` 或 `acp` 上设置推理强度会在执行时明确失败，而不会静默降级。

该工具仅在默认提供方存在时挂载，镜像提供方注册生命周期，并在挂载时校验默认路由的能力：数值型 `maxDepth` 要求 `depthLimit`，已配置的 `reasoningEffort` 要求 `reasoningEffort`。

## 配置

| 键 | 含义 |
|---|---|
| `provider`（必填） | 未显式指定 `provider` 的子任务所使用的默认 `ctx.subagents` 提供方。 |
| `toolName` | 面向模型的名称，默认 `orchestrate`；每个已加载实例必须不同。 |
| `model` | 未命名模型的子任务所使用的默认模型 id；省略时保持各提供方自身的路由解析。 |
| `reasoningEffort` | 未命名推理强度的子任务所使用的默认强度，会固定到子任务上；要求挂载时默认提供方具备 `reasoningEffort` 能力。 |
| `maxConcurrency` | 并发子 agent 上限，默认 `4`，范围 `1`–`32`。 |
| `maxSubtasks` | 提交子任务数的包含性上限，默认 `8`，范围 `1`–`64`。 |
| `maxDepth` | 每次启动都会发送的绝对委派深度上限，默认 `3`；`'provider-managed'` 表示不发送上限。数值上限要求每个目标提供方具备 `depthLimit` 能力。 |
| `allowProviderOverride` | 子任务是否可自行命名 `provider`，默认 `true`；禁用时会在执行时拒绝任何显式提供方。 |

## 并发

调用并发安全，与 `dsh-tool-subagent` 一致：子 agent 绝不变更父会话，同级编排调用在循环的滚动池下重叠执行。一次调用内，调度器在 `maxConcurrency` 约束下拥有扇出并行度；协调同级工作区效果的职责仍归模型。

## 模型体验

### 工具 schema

#### 模型看到的内容

在默认提供方存在期间，以配置名称生成的 [`orchestrate` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-orchestrate)，参数为 `task` 与 `subtasks` 数组 `{ id, title, prompt, provider?, model?, effort?, depends_on? }`。可见期间，`tool:<toolName>` 系统提示词 section 会说明何时优先使用本工具而非普通 subagent 调用，告知模型保持独立子任务并行并粘贴每项所需的确切材料，列出当前已注册的提供方，警告显式推理强度需要进程内提供方，并指示父级在采取行动前复核所有返回结果。

#### Token 影响

每个父级请求固定的 schema 开销，外加每个实例一个简短的系统提示词 section。

#### KV Cache 影响

在提供方注册与配置不变时前缀保持稳定；提供方生命周期变化会使父级复用从首个变化的程序集起失效。

### 编排结果

#### 模型看到的内容

一份渲染后的 transcript：计数标题（`completed/total`、失败、跳过），随后按子任务分节展示状态、路由，以及收集到的输出（按输出的显示预算裁剪并给出显式截断提示）或终止原因、诊断与跳过原因。规范值为完整的结构化行集；仅渲染会被裁剪。

#### Token 影响

每个子任务的渲染输出都会进入父级历史，直至上下文压缩（context compaction）；子 agent 工作上下文留在子会话中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **仅前台**——调用在整张图结算后才返回；长图尚无法像单个 `subagent` 委派那样驻留到后台 Task。
- **可继续子 agent 拒绝显式推理强度**——持久化描述符格式不承载推理强度固定，因此 `startContinuable` 会明确拒绝显式推理强度，而不是在冷恢复时静默丢弃。
- **无结构化单任务捕获**——结果以子 agent 最终 assistant 文本收集；若需 schema 约束的结果，需要将该 seam 的 `outputSchema` 能力经由调度器接入。
