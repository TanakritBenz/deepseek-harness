# Agent Note: 扇出委派编排与 seam 层推理强度固定

Status: implemented

[English](2026-08-25-subagent-orchestrate-and-effort-pinning.md) | 中文

## 问题

subagent 家族中同时暴露出两个缺口。其一，单次委派（`dsh-tool-subagent`）每次调用仅启动一个子 agent，因此可拆分为独立片段的任务每片都要花费一次父级往返，而跨轮次的并行只能由模型即兴实现，而非由运行时保障。其二，harness 中没有任何 surface 可固定子 agent 的推理强度：`AgentOptions` 仅承载提供方／模型，`LlmCallConfig.reasoningEffort` 是按请求维度的状态，却没有任何路径为委派子级填充该值，而工作流（workflow）工具则直接拒绝推理强度覆盖。

## 决策

该 seam 新增一项启动时能力及其对应的请求字段：`SubagentCapabilities.reasoningEffort` 与 `SubagentStartRequest.reasoningEffort`。服务像校验其他每个 flag 一样，依据能力校验其存在性。进程内后端通过 `pinChildReasoningEffort` 实现该字段——一个在驱动器创建窗口内安装的、限定作用域的 `agent/request` 监听器，会为子 agent 整个运行期间覆盖任何继承的推理强度；进程外后端不声明该能力，并在启动时拒绝显式推理强度，绝不先接受后忽略。可继续启动会直接拒绝显式推理强度，因为持久化描述符格式不承载推理强度固定，若在创建时接受该值，会在冷恢复时静默降级。

`dsh-tool-subagent-orchestrate` 是该 seam 之上的一个新的可选 Consumer。模型在一次调用内完成分治——一组自包含的子任务，携带可选的 `provider`、`model`、`effort` 与 `depends_on` 依赖边——由本包以最大合法并行度调度：按依赖有序启动、无层级屏障、受 `maxConcurrency` 限制。失败的子任务仅会传递性地跳过其依赖者；独立分支会完成并上报。规范结果为每个子任务一行（状态、路由、输出或终止原因／诊断／跳过原因），调用方 agent 保留编排职责：复核每个结果、整合正确成果、自行修复薄弱部分，或用更精确的提示词重新委派。单节点路由复用既有 seam 字段——`agentOptions.model` 用于模型，新增的推理强度字段用于推理强度——因此供应商覆盖跟随提供方注册而非工具逻辑：DeepSeek 走进程内提供方的 LLM 适配器，Claude 走 `claude-code`，ChatGPT 走 `codex`，OpenCode 走 `acp`。

## 考虑过的替代方案

**提升描述符版本并将推理强度带入可继续子 agent。** 对固定值做快照可使恢复行为统一，但版本 3 会使每个已持久化可继续子 agent 的分类失效，而当前没有任何消费方需要在可恢复会话上使用该功能。在可继续路径上直接拒绝显式推理强度，是在决策点明确失败，而非在恢复时静默降级。

**让工具自行通过 `ctx.agents.create` 组合子 agent。** 这会绕过该 seam 的能力校验、生命周期事件、描述符落盘与策略捕获，并重复每个提供方的传输工作。扇出保持为 Consumer，使每个后端无需按提供方编写代码即可受益。

**以拓扑波次表达依赖。** 波次调度更简单，但在层级间插入屏障：即使某条快速分支的依赖已早早完成，仍需等待最慢的同级层完成。事件驱动的就绪会在每个节点最后一个依赖结算时立即启动该节点。

**通过该 seam 的 `outputSchema` 收集结构化结果。** 受 schema 约束的行可进一步收紧复核，但目前仅进程内提供方声明该能力，混合供应商的图不能让部分分支静默丢失结构。文本结果使所有提供方保持一致；结构化捕获延后至能力覆盖更广后再接入。

## 后果

`packages/subagent/subagent` 导出 `pinChildReasoningEffort`；spawn／fork 提供方声明 `reasoningEffort: true`；`NO_START_CAPABILITIES` 新增该 false 标志，因此每个进程外后端都会继承该拒绝行为。`dsh-tool-subagent-orchestrate` 作为可选包发布，带有自有调度器（`validateSubtaskGraph`、`runSubtaskGraph`）、挂载时默认路由校验、提供方生命周期工具挂载，以及一段 `tool:<toolName>` 提示词 section，说明何时优先使用编排而非普通委派。验证：`subagent/tests/service.spec.ts` 中的服务门禁与透传测试、一个 spawn 端到端固定测试（断言子请求携带推理强度而父级不携带）、针对并行度／依赖／取消／环的调度器单元测试，以及针对路由、失败级联、生命周期挂载与提示词指引的脚本化提供方组合测试，以及一个无密钥 Loader smoke（`tests/loader-composition.e2e.ts`，基于仅用于测试的 cordis.yml），脚本化模型通过一次 `orchestrate` 调用将两个真实 spawn 子级并行扇出，父级复核两份结果。
