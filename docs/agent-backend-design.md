# dsh-TUI 多后端架构与 Claude 原生后端：最终技术方案（施工蓝图 v1）

> 状态：设计定稿，交付给实现 Agent（Opus 5.5）执行。本文不是 PR，是施工单。
> 依据：仓库源码审计（本分支 `feat/launchpad-onboarding`，HEAD `1539b181`）、本机实际安装的
> `@anthropic-ai/claude-agent-sdk@0.3.287` 公共类型声明、本机 `claude` CLI 2.1.287 的两次运行探针、
> 官方文档（code.claude.com / support.claude.com，2026-10-01 读取）、`claude-agent-acp@0.85.0` 源码。
> 旧版泄露源码只用于"该去验证什么"，本文中没有任何结论单独依赖它。

---

## 0. 结论速览

**裁定一句话**：在 `ChannelUi` 之下、`createChannel()` 之内，插入一个与厂商无关的 **Agent Domain**
（事件词汇表 + 会话句柄 + 类型化能力），把现有 DSH 的 projection/action 改写成"DSH 翻译器 + 共享投影器"，
再以同一套投影器承载 Claude 后端。`src/adapter/` 不动（它是插件宿主平面，不是后端层）；
`src/dsh-adapter/` 保留，其中 DSH 专属能力按 capability 挂载；新增 `src/agent/`（领域）、`src/channel/`
（中立投影与动作核心，逐步从 `dsh-adapter/channel/` 迁入）、`src/backends/claude/`。

**不可妥协点的落实方式**：

| 原则 | 落实 |
| --- | --- |
| Native-first | Claude 后端直接基于 Claude Agent SDK streaming-input `query()`，一条会话一个长寿命 query；不经 ACP |
| ACP 只是外部协议 | ACP 作为未来 `src/backends/acp/` 的一个翻译器插入同一 Agent Domain；它研究出的映射（工具卡、权限选项、子代理、后台任务、压缩）被本文吸收为设计输入，而不是内部模型 |
| DSH 零降级 | DSH 路径通过"翻译器 + 共享投影器"迁移，用录制日志做**旧投影器 vs 新投影器逐行等价**的黄金测试；现有 `channel-ui` 58 项、CI 三回归、compact/rewind/thinking/toolcard 聚焦脚本全部保留 |
| 不出现四套 Channel | 只有一个 `createChannelProjection()`、一个 `ChannelState`、一个 `Chat.tsx`；后端差异全部收敛在翻译器与 capability 上 |
| 不靠想象填空 | 本文每一条 Claude 行为都标注来源：`[d.ts]` 类型声明、`[P1]`/`[P2]` 两次探针、`[docs]` 官方文档、`[acp]` claude-agent-acp 源码；仍不确定的列入 §8 的"施工前探针清单"，施工 Agent 必须先跑探针再写代码 |

**给 Opus 的三条硬约束**：

1. 按 §8 的 Phase 顺序分 PR 提交，每个 Phase 的 Gate 全绿才进入下一个；Phase 1 结束时 DSH 用户体验与行为必须与 `main` 逐行一致（黄金测试证明）。
2. `src/agent/**`、`src/channel/**` 不得 import 任何厂商包（`@deepseek-ai/*`、`@anthropic-ai/*`、`@agentclientprotocol/*`、`@dsh-std/*`）；`screens/`、`components/` 不得 import `src/backends/**`。门禁见 §8.0。
3. 施工过程中遇到本文与真实运行行为不符时，以探针为准，并在 PR 描述里记录偏差；不要静默绕过。

---

## 1. 事实基础（证据清单）

| 来源 | 内容 | 如何获得 |
| --- | --- | --- |
| 仓库审计 | `src/adapter/`（约 80 文件）、`src/dsh-adapter/`（60 + 57 文件）、`src/screens/*`、`src/components/*` 的职责与耦合图 | 全文阅读 + 3 个只读审计 |
| SDK 类型 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（9 927 行）、`core.d.ts`、`package.json` | 在 scratchpad `npm install @anthropic-ai/claude-agent-sdk@latest`，解析得 0.3.287，`manifest.json` 声明 CLI 2.1.287 parity |
| 探针 P1 | 一条 streaming-input 会话跑 6 阶段：CLAUDE.md 加载、Write 审批、子代理、后台 Bash、流中 interrupt、`setPermissionMode('acceptEdits')`、`rewindFiles(dryRun)`、`initializationResult/supportedCommands/supportedModels/supportedAgents/mcpServerStatus/getContextUsage/accountInfo`、`listSessions/getSessionInfo/getSessionMessages/listSubagents/getSubagentMessages` | `scripts`（施工时迁入 `scripts/probes/claude-sdk-probe.mjs`）；本次运行记录在 scratchpad `probe-run/trace.jsonl` |
| 探针 P2 | 省略 `permissionMode`、`title`、AskUserQuestion 经 `canUseTool`、deny、审批挂起时 `interrupt()`（signal 是否触发）、`setModel('sonnet')` 的 thinking 可见性、`/compact` 作为 prompt、`getSessionMessages(includeSystemMessages)`、`forkSession` + `resume` 的回放形态、启动延迟 | 同上 `trace2.jsonl` |
| 本机 CLI | `claude --help`（2.1.287）全部 flag；`~/.claude/projects/<cwd>/<id>.jsonl` 真实转录格式与 `subagents/agent-*.jsonl` | 直接读取 |
| 官方文档 | Agent SDK overview（含第三方登录条款与品牌指引）、Help Center「Agent SDK 与订阅用量」 | WebFetch，原文引用见 §4.13 |
| 先例 | `claude-agent-acp@0.85.0`（pin SDK 0.3.286）：`acp-agent.ts` 消费循环、`permissions/*`、`native-subagents.ts`、`async-tasks.ts`、`context-compaction.ts`、`fork-session.ts`、`resumed-session.ts` | clone 到 scratchpad 并逐文件审计 |

探针关键结论（后文反复引用）：

- `[P1]` `settingSources:['user','project','local']` + `systemPrompt:{type:'preset',preset:'claude_code'}` 下，项目 `CLAUDE.md` 生效（codeword 测试通过）；`[P2]` 省略 `settingSources` 同样生效（SDK 文档：省略 = 全部加载）。
- `[P2]` 省略 `permissionMode` 时本机得到 `permissionMode:'default'`（用户 settings 无 `defaultMode`）。d.ts 注释说"省略时跟随 `claude -p`：settings 的 `defaultMode`，否则 `auto`"。**结论：TUI 永远显式传 `permissionMode`**，起始值用 `resolveSettings()` + `filterEscalatingDefaultMode()` 读用户设置。
- `[P1]` 每个 turn 恰好一个 `result`；`system/init` 在**每个 turn 开头重发**（7 个 turn 得到 8 次 init）；`command_lifecycle`（不在 `SDKMessage` 联合类型里）在每次用户发送后出现，`state:'queued'`（`[acp]` 全集：`queued|started|completed|discarded|refused|cancelled`）。
- `[P1]` 本账号/模型下 thinking 内容为空字符串，仅有 `signature_delta` 与 `system/thinking_tokens` 估算（`stream_event` 带 `thinking_display:'updates'`）；`[P2]` 切到 sonnet 亦然。UI 必须支持"只有 token 计数、没有正文"的 thinking 态。
- `[P1]` `assistant` 消息**按内容块逐条发出**，同一 API 响应的多条共享 `message.id`，`stop_reason:null`；工具结果以 `user` 消息（`tool_result` 块）到达，并带结构化 `tool_use_result`（Write：`{type:'create',filePath,content,structuredPatch,originalFile}`；Read：`{type:'text',file:{...}}`；Bash：`{stdout,stderr,interrupted,backgroundTaskId?}`）。
- `[P1]` `canUseTool` for Write：`suggestions:[{type:'setMode',mode:'acceptEdits',destination:'session'}]`、`displayName:'Write'`、`description:'hello.txt'`、`toolUseID`、`requestId`；`[P2]` Bash：`suggestions` 含 `addRules(localSettings)` / `addDirectories(session)` / `setMode`，并带 `blockedPath`。
- `[P2]` `AskUserQuestion` 通过 `canUseTool` 到达（`requiresUserInteraction:true`，`input.questions[]`），用 `{behavior:'allow', updatedInput:{...input, answers:{[question]: label}}}` 作答。
- `[P2]` 审批挂起时调用 `interrupt()`：`opts.signal` 立即 abort（`AbortError`），CLI 自行写入 "User rejected tool use" 结果，发 `[Request interrupted by user for tool use]`，`result/error_during_execution` + `terminal_reason:'aborted_tools'`；迟到的 resolve 无害。
- `[P1]` 流中 `interrupt()`：被中断的 assistant 消息带 `aborted:true`，随后 `user` 文本 `[Request interrupted by user]`，`result/error_during_execution` + `terminal_reason:'aborted_streaming'`、`errors:['[ede_diagnostic] …']`；`interrupt()` 返回 `{still_queued:[uuid]}`——**被中断的是当时运行的 turn（可能是系统发起的 task-notification turn），用户刚发的消息仍在队列里并随后自动运行**。
- `[P1]` 子代理：本机环境下 `Agent` 工具异步启动（`task_started.is_backgrounded:true`，`task_id` 即 agentId；是否默认异步可能受账号 feature gate 影响，翻译器必须同时支持前台与后台两种形态），子代理消息带 `parent_tool_use_id`/`subagent_type`/`task_description`，完成时 `task_updated{status:'completed'}` + `task_notification{summary,usage}`，CLI 自动开启一个 `origin:{kind:'task-notification'}` 的 turn 让模型汇报；`SubagentStop` hook 给出子转录路径。
- `[P1]` 后台 Bash：`task_started{task_type:'local_bash',is_backgrounded:true}`，`background_tasks_changed`（REPLACE 语义），完成后 `task_notification`；turn 结束不等于任务结束。
- `[P2]` `/compact` 作为 prompt 发送：`system/compact_boundary`（含 `pre_tokens/post_tokens/preserved_*`）→ 合成 user 消息（摘要，`isSynthetic:true`）→ `<local-command-stdout>Compacted</local-command-stdout>`（`isReplay:true`）→ `result{num_turns:0}`；压缩后 `getSessionMessages` **只返回压缩后链路**（8 条），完整历史仍在 JSONL 文件里。
- `[P2]` `setModel('sonnet')` 会以 `user{isReplay:true}` 回显 `<local-command-stdout>Set model to …</local-command-stdout>`；`title` 选项触发 `system/session_title_changed`（联合类型外的 subtype）。
- `[P2]` `forkSession(id,{title})` 17ms；`query({resume})` 到 `init` 653ms，**不回放历史消息**，历史需 `getSessionMessages` 另取；新会话冷启动到 `init` 782ms，首 token ≈1.5s。
- `[P1]` `listSessions({dir})` 19ms、`listSessions()` 全局（8 个会话）21ms/冷 10ms/热；`getSessionMessages` 9ms（39 条，thinking/text/tool_use 分块，带 `parent_agent_id`）。
- `[P1]` `accountInfo()` → `{organization, subscriptionType:'Claude Team', apiProvider:'firstParty'}`，`init.apiKeySource:'none'`（即复用了 `claude login` 的 OAuth）；`rate_limit_event` 带 `unifiedWindows.five_hour/seven_day.utilization`（联合类型外字段）。

---

## 2. 当前架构审计（A）

### 2.1 `src/adapter/`：插件宿主平面，不是后端层

- 它是 "TUI Adapter v2" 的**宿主能力平面**：`ports/`（Host Ports + `ChannelUi` 契约类型）、`kernel/`（shadow policy / KernelRuntime / HostFacade / ledger / 诊断）、`upstream/`（9 个 driver，全部包装 dsh-tui **自己的** Cordis 服务 `tuiWorkspaces/tuiScenes/…`，没有任何 `@deepseek-ai` import——"upstream = 未来 @deepseek-ai 驱动之家"的注释是错的）、`channel/`（渲染侧只读能力包装 `createChannelUi`/`read-view`/`host-registry` + P4 端口拆分 + P5 协议 replay provider）、`standard/`+`spec/`（dsh-std 插件准入平面）。
- 默认 `DSH_TUI_ADAPTER_MODE=legacy`（`kernel/runtime.ts:21`）：KernelRuntime、slices、全部 upstream driver、HostFacade 端口在生产中**休眠**；真正跑的只有 `channel/ui.ts`、`ui-policy.ts`、`read-view.ts`、`host-registry.ts`、`kernel/runtime.ts` 的 effect 矩阵、`ledger.ts`、`standard/`+`spec/`。
- 其中没有任何"事件源 / submit-cancel 驱动"的抽象。`HostChannelPort`（`ports/channel.ts:155`）是**覆盖在既有 Channel 之上的视图**，不是生产者；`ChannelProvider`（`channel/provider.ts:33`）只有 replay 实现；`UpstreamDriver` 是能力探测/挂载，不是事件源。
- 死代码/占位：根 barrel `src/adapter/index.ts` 无人 import；`assertAdapterCapability` 无调用；`kernel/replay.ts`、`channel/session-projection.ts` 仅脚本使用；除 `descriptor` 与 `channel.projection.ui` 外的 HostFacade 端口仅脚本使用。
- 反向依赖：`kernel/runtime-context.ts:3`、`channel/host-registry.ts:17` import `dsh-adapter/host-access.js`（它 import `@deepseek-ai/cordis`）；`channel/{actions,plugins,projection,state,transcript}.ts` 与 `upstream/channel-driver.ts` 依赖 dsh-adapter 的具体 `Channel` 类型。

**裁定**：`src/adapter/` 原样保留，语义澄清为"TUI 宿主/插件平面"。Agent Backend 层**不**放进 `kernel/` 或 `upstream/`（那会把"能力探测"与"事件源"两个概念揉在一起），而是与之并列。新后端只复用其中四样：`ports/channel-*` 类型、`createChannelUi` + `read-view`（任何 `ChannelUi` 生产者都能用）、`kernel/runtime.ts` 的 effect 矩阵（给新动作加 `host.channel.actions.*` 条目）、`host-registry`。

### 2.2 `src/dsh-adapter/`：DSH 宿主集成 + DSH 后端 + Channel 组合根

`channel.ts`（1 114 行）是组合根，装配约 40 个 specialist。按"真正的 DSH 耦合"分三类：

| 类别 | 模块（`src/dsh-adapter/channel/` 除非注明） | DSH 耦合点 |
| --- | --- | --- |
| **A. 事件/会话内核（本次要中立化）** | `projection.ts`（唯一 reducer，1 188 行；`SessionEvent`/`AssistantStreamFrame`/`StreamChunk` 类型；事件 `user/message`、`step/*`、`assistant/attempt|message|chunk`、`tool/call|result`、`turn/*`、`request/header|context`、`system/message`、`session/title|color`、`goal/change`、`todo/write`、`agent-preset/selected`、`compaction/start|end`）、`binding.ts`（`Agent`/`AgentHandle` 身份单写者）、`binding-events.ts`（`ctx.on('session/event'|'agent/assistant-stream'|'subagent/start|end'|'agent/status'|'agent/disposed'|'agent/inbox/*'|'llm/stream')`）、`input-delivery.ts`（`createUserMessage` + `agent.steer/followup`，`agent/pre-step` 附件）、`input-actions.ts`、`subagent-projection.ts`（`Agent` 类型、`ctx.get('agents'|'subagents')`）、`job-projection.ts`（`ctx.jobs` 注册表）、`transcript.ts`（`foldBack`/`restoreRowFromEvent` 读 `SessionEvent`）、`session-reset.ts`、`emitter.ts`（中立）、`usage.ts`（`StreamChunk`）、`state.ts`（`AgentHandle` 类型） | `Agent`、`SessionEvent`、流帧、Cordis 事件名 |
| **B. DSH 专属动作（保留，按 capability 挂载）** | `session-resume.ts`/`session-adoption.ts`/`session-live-adoption.ts`（`ctx.agents.create/resume`、挂载账本 `sessionMounts`）、`session-fork.ts`/`session-rewind.ts`/`session-tree*.ts`（dsh-session fork 血缘）、`model-actions.ts`/`model-switch.ts`（dsh-llm 路由、fork 换模型）、`mode-*.ts`/`permissions.ts`（`permissionPresets` 服务、plan/sandbox/approval 原子）、`compaction.ts`、`external-commands.ts`/`commands.ts`（dsh-commands）、`skill-catalog.ts`、`loaded-context.ts`（dsh-system-prompt）、`agent-view-projection.ts`/`background-action.ts`（进程内后台 Agent）、`reports.ts`（balance/doctor/mcp/export）、`session-metadata.ts`、`workspace-actions.ts`（dsh-workspace）、`composer-images.ts`/`mentions.ts`（`attachments`/`fs` 服务）、`local-actions.ts`（`shell` 服务） | Cordis 服务名 + `@deepseek-ai` 类型 |
| **C. 宿主/插件接缝（后端无关，原样）** | `settings-host.ts`、`preferences.ts`、`notifications.ts`、`owner.ts`、`action-readiness.ts`、`lifetime-resources.ts`、`context-bookkeeping.ts`、`command-completions.ts`、`decisions.ts`（tui/* 决策事件）、`ide-selection.ts`、`question-record.ts`；`../approvals.ts`（审批 FIFO；但 outcome 集合是 DSH 的 `allowed-once|rejected|cancelled`）、`../questions.ts`（`QuestionStore`，答案形状 `{answers:[{id,selected,custom}]}`）、`../plugin-host.ts`、`../themes.ts`、`../dialogs.ts`、`../status.ts`、`../shortcuts.ts` | 仅 `Context` |

`plugin.ts`（2 126 行）引导顺序：TTY 门禁 → settings namespace → 预设注册 → 语言 → userQuestions/QuestionStore → 子进程 stderr 守卫 → 路由解析 → `resolveAgent()`（`ctx.agents.create/resume`，挂载账本）→ workspace 归属 → `createChannel(ctx, agent, …)` → `registerTuiChannel` → `mountChannelUi` → 审批 answerer（`ctx.on('approval/request')` + `approvalStore`）→ React `render()` → 退出漏斗 `createExitFunnel`/`finishExit`。其中只有 `resolveAgent()` 与审批 answerer 两段是 DSH 后端语义，其余是宿主装配。

### 2.3 UI 层对契约的真实依赖（决定什么必须共享）

- 所有 screen/component 只类型化到 `ChannelUi`（`src/adapter/ports/channel-ui.ts:16-617`），从不触碰 `ChannelState` 的内部成员；`bindApprovalStore` 只在 `plugin.ts:1211` 调用。UI 没有 `@deepseek-ai/*`、`@dsh-std/*` import（`verify:boundary` 保证）。
- UI 对 `src/dsh-adapter/*` 的**值** import（运行时耦合，本次顺手清理的对象）：`Chat.tsx:29` `sessionCwdMatches`（**未使用**，却把整个 channel 实现拉进 UI 模块图）；`Chat.tsx:31-32`、`ExtensionDialog.tsx:43` 的 `TuiDialogStore`/`TuiStatusStore`（inert fallback，间接 import cordis）；`Chat.tsx:39` `ApprovalStore`（经 `compat/liveSession` 拉进 `dsh-session`）；`Chat.tsx:38` `runProviderWizard`（dsh-user-questions）；`Chat.tsx:80-82,1810` migrate 系列；trajectory 系列（`trajectory/guards.ts` 解析 DSH 事件类型）；`LogoV2.tsx:4` 版本漂移横幅。其余为纯类型或无依赖工具（`sanitize.ts`、`jobs.ts:formatJobDuration`、`sessionTree.ts` 纯函数等）。
- `ChatRow` 11 种 kind 全部被 `MessageList.tsx:1497-1716` 消费；`ToolRow` 的 `callView/resultView.card ∈ generic|terminal|diff|read|search` 决定卡片形态（`AssistantToolUseMessage.tsx:215-255,369-376`）；**UI 不按工具名选卡片**，卡片形态由 adapter 的 presenter 决定，这正是 Claude 工具映射的接入点。
- `approvalStore`/`questionStore` 以 Chat **props** 注入（`plugin.ts:1402-1406`），审批只有 `allowed-once|rejected` 两种决定（`ApprovalPanel.tsx:31`）；审批/提问挂起时 Chat 的全局键处理提前返回（`Chat.tsx:3439-3447`），Esc/Ctrl+C 不取消 turn。
- UI 内硬编码的 DSH 假设（需要 capability 化或改为后端提供的文案）：`agentId === sessionId`（`StatusLine.tsx:450`、`ApprovalPanel.tsx:69`、`Chat.tsx:4254,4501`）；`/model provider/id` 语法（`Chat.tsx:2241-2244`）；mode 原子 `sandbox/approval/plan`（`sessionModes.ts:16-46`、`StatusLine.tsx:209-219`、`PromptInput.tsx:2954,3551`）；外部命令名 `'permission'`/`'plan'`（`Chat.tsx:1740,2742,2804`）；DeepSeek 计价/余额/`DEEPSEEK_API_KEY`（`StatusLine.tsx:366-383`、`Chat.tsx:2689-2711`、`Onboarding.tsx:129,576`）；effort 梯度 `effortPrefs.ts:54`；会话浏览器 `'DSH'` tab（`SessionSupervisor.tsx:166,180`）。
- slash 命令中后端无关的：`new clear compact resume rename recap rewind fork export btw bg model effort status tokens skills mcp agents context workspace jobs settings`；DSH 专属的：`preset permission plan goal tree trace migrate provider login balance cost config doctor plugins init reload setup` 与 Shift+Tab `cycleMode`。

### 2.4 既有 Adapter v2 设施的裁定表

| 设施 | 裁定 | 理由 |
| --- | --- | --- |
| `ports/channel-ui.ts` `ChannelUi` | **保留并扩展**：新增 `capabilities` 只读快照与 `sessionRef{backendId,sessionId}`，`costReport`，DSH 专属成员改为"能力缺席时显式失败 + 通知" | UI 唯一边界，已被 70+ 属性/100+ 方法消费 |
| `ports/channel-view.ts` 行/工具/子代理/任务类型 | **保留，小幅泛化**：`ChatRow.anchor?: string`（后端原生锚点）、`SubagentState` 增 `backendId?`、`JobRow/BackgroundJobState` 增 `outputFile?` | 两个后端都能装下 |
| `ports/channel.ts` `HostChannelPort` 及 P4 拆分 | 原样（休眠） | 不是本次主题，不碰 |
| `channel/ui.ts`、`read-view.ts`、`host-registry.ts` | **复用** | 后端无关 |
| `kernel/runtime.ts` effect 矩阵 | **复用**：为新增动作登记 `host.channel.actions.permission-respond` 等 | shadow 门禁覆盖新动作 |
| `channel/provider.ts`/`session-projection.ts`（P5） | 原样；未来 ACP **不**走它 | 它是 TUI 协议的提供方，不是 Agent 协议 |
| `upstream/*` driver 概念 | 原样；**不**用于后端 | 概念冲突 |
| `standard/`+`spec/` | 原样 | 插件平面与后端无关 |
| `verify-adapter-boundary.ts` | **重写规则**（§8.0） | 当前注释与实现不一致 |
| `src/dsh-adapter/migrate/adapters/claude-code.parse.ts` | **复用其 JSONL 解析原语**于 Claude 后端的"压缩前历史 loadOlder"（只读，不再导入成 DSH 会话） | 已经理解 Claude 转录格式 |

### 2.5 边界门禁的不一致（顺手修）

- `scripts/verify-adapter-boundary.ts:2-3` 注释允许 `src/adapter/upstream/`，实现（`:14,41`）只豁免 `src/dsh-adapter/`；`verify-adapter-skeleton.ts:43,58` 又允许 upstream；`ADAPTER.md:5`、`AGENTS.md` 只写 dsh-adapter。
- 两个门禁都只扫描直接 specifier，`kernel/runtime-context.ts` 经 `host-access.ts` 传递 import cordis 未被发现。

---

## 3. 目标架构（B）

### 3.1 分层与依赖方向

```text
                 screens/ · components/ · ink/            (UI；只读 ChannelUi；无厂商 import)
                                 │ ChannelUi (src/adapter/ports/channel-ui.ts)
                 createChannelUi + read-view + host-registry   (src/adapter/channel；复用)
                                 │
            ┌────────────────────┴─────────────────────┐
            │  Channel 入口  src/dsh-adapter/channel.ts   │  ← 接收 AgentSession（或裸 DSH Agent）
            │   ├ dsh-adapter/channel/core/  后端中立核心 │  ← 任何会话都走它（Phase 4a）
            │   ├ src/channel/projection.ts  共享投影器    │  ← AgentEvent → ChannelState（唯一 reducer）
            │   ├ src/channel/{subagents,tasks,pending,   │
            │   │     permissions,questions,usage}.ts     │  ← 中立 store（从 dsh-adapter 迁入）
            │   └ dsh-adapter/channel/extensions.ts       │  ← DSH specialist：仅当 native.dsh 存在时挂载
            └────────────────────┬─────────────────────┘
                                 │ AgentSession / AgentEvent / capabilities
                        src/agent/  (Agent Domain；零厂商依赖)
                                 │
     ┌───────────────────────────┼────────────────────────────┐
 src/dsh-adapter/backend/   src/backends/claude/        src/backends/acp/ (未来)
 DSH 翻译器+会话             Claude Agent SDK 翻译器+会话  ACP 翻译器+会话
     │                           │                            │
 @deepseek-ai/*  (Cordis 服务)  @anthropic-ai/claude-agent-sdk  @agentclientprotocol/sdk

 横向：Cordis 宿主 + src/adapter/*（settings/themes/plugin host/workspaces/scenes/decision events）对所有后端共享
```

依赖方向：`UI → ports`；`channel → agent + ports + 宿主服务`；`backends/* → agent + 各自厂商 SDK`；`agent → 无`。
禁止：`agent`/`channel` import 厂商包；UI import `backends/*`；`backends/*` 互相 import；`backends/*` 直接改 `ChannelState`。
`agent`/`channel` 也不 import `src/ink/**`，唯一登记的允许边是 `src/channel/sanitize.ts → src/ink/stringWidth.ts`（纯叶子：显示单元宽度，无渲染器状态；Phase 2 起 `verify:boundary` 按文件对放行）。

### 3.2 目录

```text
src/agent/                      Agent Domain（纯类型 + 纯函数，无 I/O）
  events.ts                     AgentEvent 联合类型与身份字段
  session.ts                    AgentSession / AgentInput / 取消与提交回执
  capabilities.ts               类型化可选能力接口（permissions/questions/models/effort/modes/compact/rewind/fork/subagents/tasks/mcp/commands/context/account/catalog/native）
  backend.ts                    AgentBackend / AgentBackendDescriptor / 检测结果 / 注册表
  refs.ts                       AgentSessionRef {backendId, sessionId} 与序列化规则
  presentation.ts               ToolPresentation 接口（工具卡形态的后端中立描述；复用 ToolCallView/ToolResultView 类型）
  index.ts
src/channel/                    中立投影与 store（从 dsh-adapter/channel 迁入/新建）
  projection.ts                 createChannelProjection(state, deps): AgentEvent → ChannelState（唯一 reducer）
  pending.ts                    pending 队列（lifecycle 驱动）
  subagents.ts                  SubagentActivityStore（从 dsh-adapter/subagents.ts 迁入，去 Agent 类型）
  tasks.ts                      BackgroundTaskStore（从 jobs.ts 泛化）
  permissions.ts                PermissionStore（审批 FIFO，泛化 approvals.ts 的 outcome 集合）
  questions.ts                  QuestionStore（迁入；答案格式不变）
  usage.ts / transcript.ts / emitter.ts / session-reset.ts   迁入（去厂商类型）
src/backends/claude/            Claude 后端（唯一允许 import @anthropic-ai/* 的目录）
  backend.ts                    ClaudeBackend：detect()/open()/catalog
  session.ts                    ClaudeAgentSession：query() 生命周期、Inbox、interrupt、capabilities
  translate.ts                  SDKMessage → AgentEvent（纯函数 + 小状态机；可用 fixture 测）
  replay.ts                     getSessionMessages/getSubagentMessages → AgentEvent（复用 translate 的块级映射）
  permissions.ts                canUseTool/onElicitation/onUserDialog 桥；选项生成；signal 处理
  tools.ts                      工具名 → ToolPresentation（Read/Edit/Write/MultiEdit/NotebookEdit/Bash/PowerShell/Glob/Grep/WebFetch/WebSearch/Agent/Task/AskUserQuestion/ExitPlanMode/TodoWrite/Skill/mcp__*）
  options.ts                    Fidelity Profile：组装 query Options
  process.ts                    可执行文件定位、env 清洗、版本/能力检测、stderr 捕获
  catalog.ts                    listSessions/getSessionInfo/fork/rename/delete 适配 + 原生 JSONL 旧历史读取
  contract.ts                   VALIDATED_SDK_VERSIONS / VALIDATED_CLI_VERSIONS / 能力 feature-detect
  i18n.ts                       后端自带的用户可见文案键（注册到 src/i18n.ts 的 backend-claude-* 家族）
src/dsh-adapter/backend/        DSH 后端（DSH 翻译器 + 会话）
  backend.ts  session.ts  translate.ts  replay.ts  catalog.ts
src/dsh-adapter/channel.ts      Channel 入口：createCoreChannel → （native.dsh 时）attachDshExtensions → start（Phase 4a）
src/dsh-adapter/channel/core/   后端中立核心（Phase 4a；新增后端不写 channel 代码）
  compose.ts                    createCoreChannel(ctx, session, options, owner) → { state, extend, start, … }
  host.ts                       宿主接缝查找、决策闸门 + 拓扑标记、settings/scenes 订阅、git 分支面包屑
  binding-feed.ts               共享投影器 + 会话批次路由 + bind()/状态/历史回放（扩展经钩子加原始订阅者与同步种子回放）
  session-controls.ts           按能力上报的会话事实（原生模式、effort、后端命令、/mcp、/context、订阅用量）
  session-switch.ts             session-switch 否决、session-switched 通知、通用 /new（注入 opener；握手后复查）
  local-actions.ts              /clear、本地行、!cmd/!!cmd（工作区 shell）、/activity frames、loadOlder 分发
  actions.ts                    一次安装：不可用 → 能力委托（每次调用重新解析）→ 核心 → 扩展
  files.ts / reports.ts         文件查询与补全；/doctor（含 diagnostics.lines()）、/export（来自投影行）
src/dsh-adapter/channel/extensions.ts  attachDshExtensions：DSH specialist 的接线（内部实现不变）
src/backends/acp/               Phase 6 骨架（见 §7）
scripts/probes/claude-sdk-probe.mjs        探针（维护者工具，不进 CI）
scripts/fixtures/claude/*.jsonl            脱敏的真实 SDK 消息序列（CI fixture）
scripts/fixtures/dsh/*.jsonl               录制的 DSH 会话日志（黄金等价测试）
```

命名裁定：不重命名 `src/dsh-adapter/`（C 类改动）。它的含义收窄为"DSH 宿主集成 + DSH 后端"；文档与 AGENTS.md 同步更新这句话。

### 3.3 Agent Domain：事件词汇表

设计原则：**高保真超集**，不是最低公分母；每个事件携带稳定身份；`replay` 与 live 走同一词汇表；后端不懂的能力不发事件而不是发假事件。

```ts
// src/agent/events.ts（草图；施工时以此为准定稿，字段可增不可删）
export type AgentEvent =
  // 会话
  | { type: 'session.ready'; sessionId: string; cwd: string; model: string; provider?: string; title?: string;
      permissionMode?: string; effort?: string; contextWindow?: number; backendVersion?: string }
  | { type: 'session.title'; title: string; source: 'user' | 'auto' }
  | { type: 'session.color'; color: string }
  | { type: 'session.reset'; trigger: string }              // Claude conversation_reset；DSH 无
  | { type: 'session.status'; status: 'idle' | 'running' | 'requires-action' | 'disposed' }
  // 回合与步
  | { type: 'turn.start'; turn: number; origin: 'user' | 'system' | 'notification'; userMessageId?: string; time: number }
  | { type: 'turn.end'; turn: number; reason: TurnEndReason; time: number; usage?: UsageDelta; cost?: CostReport }
  | { type: 'step.start'; turn: number; step: number } | { type: 'step.end'; turn: number; step: number }
  // 用户侧
  | { type: 'user.message'; id: string; anchor: string; seq: number; turn?: number; time: number;
      source: 'user' | 'injected' | 'goal' | 'compaction' | 'command-output' | 'notification';
      text: string; blocks: readonly ContentBlockView[]; images?: readonly ImageRef[]; label?: string }
  | { type: 'pending.changed'; items: readonly PendingItem[] }   // 后端队列快照（Claude command_lifecycle / DSH inbox）
  // 助手流
  | { type: 'assistant.attempt.start'; attemptId: string; turn: number; step: number; model?: string; parentCallId?: string }
  | { type: 'assistant.delta'; attemptId: string; index: number; time: number; parentCallId?: string;
      delta: { kind: 'text'; text: string } | { kind: 'reasoning'; text: string }
           | { kind: 'reasoning-tokens'; estimated: number }          // Claude thinking_tokens（无正文）
           | { kind: 'tool-args'; callId: string; partialJson: string } }
  | { type: 'assistant.attempt.end'; attemptId: string; outcome: 'committed' | 'abandoned' | 'aborted' }
  | { type: 'assistant.message'; seq: number; anchor: string; turn: number; step: number; attemptId: string; time: number;
      model?: string; blocks: readonly AssistantBlock[]; usage?: UsageDelta; interrupted?: true; canonical: boolean;
      parentCallId?: string }
  // 工具
  | { type: 'tool.call'; seq: number; anchor?: string; turn: number; step: number; callId: string; name: string;
      argsJson: string; parentCallId?: string; agentId?: string; presentation?: ToolPresentation; time: number }
  | { type: 'tool.result'; seq: number; turn: number; step: number; callId: string; isError: boolean; time: number;
      content: readonly ContentBlockView[]; errorText?: string; structured?: unknown; meta?: unknown;
      presentation?: ToolPresentation; parentCallId?: string }
  | { type: 'tool.progress'; callId: string; elapsedMs: number; parentCallId?: string }
  // 人机交互
  | { type: 'permission.request'; request: PermissionRequestView }
  | { type: 'permission.settled'; requestId: string; outcome: PermissionOutcome }
  | { type: 'question.request'; request: QuestionRequestView }
  | { type: 'question.settled'; requestId: string }
  // 子代理与任务
  | { type: 'subagent.start'; agentId: string; parentCallId?: string; description: string; kind?: string;
      model?: string; background: boolean; time: number }
  | { type: 'subagent.progress'; agentId: string; summary?: string; lastTool?: string; usage?: SubagentUsage }
  | { type: 'subagent.end'; agentId: string; status: 'completed' | 'failed' | 'cancelled' | 'unknown'; summary?: string; usage?: SubagentUsage; time: number }
  | { type: 'task.start'; taskId: string; kind: 'shell' | 'agent' | 'workflow' | 'monitor' | string; description: string;
      command?: string; callId?: string; background: boolean; outputFile?: string; time: number }
  | { type: 'task.update'; taskId: string; patch: { status?: TaskStatus; description?: string; error?: string; background?: boolean } }
  | { type: 'task.output'; taskId: string; text: string; time: number }
  | { type: 'task.end'; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary?: string; time: number }
  | { type: 'tasks.snapshot'; taskIds: readonly string[] }      // REPLACE 语义（Claude background_tasks_changed）
  // 上下文与模式
  | { type: 'compaction.start'; trigger: 'manual' | 'auto'; cancellable: boolean; time: number }
  | { type: 'compaction.progress'; outputChars: number }
  | { type: 'compaction.end'; ok: boolean; summary?: string; preTokens?: number; postTokens?: number; error?: string; time: number }
  | { type: 'context.capacity'; contextWindow: number }
  | { type: 'context.usage'; used: number; max?: number; categories?: readonly { name: string; tokens: number; kind: string }[] }
  | { type: 'model.changed'; model: string; provider?: string; source: 'user' | 'fallback' | 'resume' | 'settings' }
  | { type: 'effort.changed'; effort: string | null }
  | { type: 'mode.changed'; modeId: string }
  | { type: 'commands.changed'; commands: readonly CommandInfo[] }
  | { type: 'goal.change'; goal?: ChannelGoal; operation: string }       // DSH 原生
  | { type: 'todo.write'; items: readonly TodoPanelItem[] }               // DSH todo/write、Claude TodoWrite
  | { type: 'preset.selected'; preset: string }                           // DSH 原生
  | { type: 'system.prompt'; text: string }                               // DSH system/message；Claude 用 context.usage 的 system 类别
  | { type: 'request.header'; model?: string; effort?: string }           // DSH request/header（用量归属真源）
  // 通知
  | { type: 'notice'; level: 'info' | 'notice' | 'warning' | 'error'; text: string; key?: string; callId?: string }
  | { type: 'rate-limit'; info: RateLimitView }
  | { type: 'custom'; nativeType: string; data: unknown }                 // 插件渲染器接缝（tuiRenderers）
```

身份约定：

| 字段 | DSH | Claude |
| --- | --- | --- |
| `seq` | 会话日志 seq（持久） | 翻译器单调计数（live 与 replay 从同一来源重新编号；仅用于排序、窗口折叠、幂等） |
| `anchor` | `String(seq)` | 消息 `uuid`（`forkSession.upToMessageId` / `resumeSessionAt` / `rewindFiles` 的锚点） |
| `turn/step` | 原生 | `turn`：每次 turn 开启 +1；`step`：同一 turn 内每个 `message_start` +1 |
| `attemptId` | `AssistantStreamFrame.attemptId` | `message.id`（`msg_…`） |
| `callId` | `tool/call.callId` | `tool_use.id`（`toolu_…`） |
| `parentCallId` | 无（子代理另有事件） | `parent_tool_use_id` |
| `agentId` | 子 Agent id | `task_id`（= `canUseTool.agentID`，`[acp]` 验证过的不成文约定） |

`TurnEndReason`：`{kind:'completed'} | {kind:'aborted'} | {kind:'interrupted'} | {kind:'error', message, category?} | {kind:'blocked', detail}`（DSH 的 `TurnEndReason` 直接映射；Claude：`result.subtype==='success'&&!is_error`→completed；`terminal_reason∈{aborted_streaming,aborted_tools}`→aborted；`is_error`→error；`error_max_turns/_budget/_structured_output`→blocked）。**实测修正 (Phase 0)**：`priority:'now'` 中断的 turn 是 `subtype:'success'` + `terminal_reason:'aborted_*'`，所以 `terminal_reason` 要先于 `subtype` 判定（§4.4）。

### 3.4 AgentSession / AgentBackend / Capabilities（TS 草图）

```ts
// src/agent/session.ts
export interface AgentSessionRef { readonly backendId: string; readonly sessionId: string }

export interface AgentInput {
  readonly text: string
  readonly blocks?: readonly ContentBlockView[]       // @ 提及附件、图片等（已由 channel 展开）
  readonly images?: readonly ImageRef[]
  readonly clientMessageId: string                     // channel 生成；后端回显用于 pending/turn 归属
}
export type SubmitPlacement = 'turn' | 'steer' | 'followup' | 'now'
// turn: 空闲则开新回合；steer: 并入运行中的回合（DSH 下一步边界 / Claude 下一工具轮次）；
// followup: 回合结束后再跑；now: 中断当前回合并立即投递（Chat 的 interruptAndDeliver）

export interface AgentSession {
  readonly ref: AgentSessionRef
  readonly cwd: string
  readonly status: 'starting' | 'idle' | 'running' | 'requires-action' | 'disposed'
  readonly capabilities: SessionCapabilities
  /** 持久真源的回放种子：返回与 live 同词汇表的事件（含 replay:true 标记）。 */
  history(): Promise<readonly AgentEvent[]>
  subscribe(listener: (batch: readonly AgentEvent[], meta: { replay: boolean }) => void): () => void
  submit(input: AgentInput, placement: SubmitPlacement): Promise<{ accepted: boolean; reason?: string }>
  removePending(clientMessageId: string): Promise<boolean>
  cancel(cause: 'user' | 'switch' | 'dispose'): Promise<{ stillQueued: readonly string[] }>
  dispose(): Promise<void>
}

// src/agent/capabilities.ts —— 每项都是可选的类型化对象；缺席 = 后端不支持（UI 显式提示，不静默 no-op）
export interface SessionCapabilities {
  readonly permissions?: { respond(requestId: string, decision: PermissionDecision): void; pending(): readonly PermissionRequestView[] }
  readonly questions?:   { respond(requestId: string, answers: QuestionAnswers): void; cancel(requestId: string): void }
  readonly models?:      { list(): Promise<readonly ModelOption[]>; current(): ModelRef; set(ref: ModelRef): Promise<ModelSwitchOutcome> }
  readonly effort?:      { levels(): readonly EffortOption[]; current(): string | undefined; set(id: string | null): Promise<void> }
  readonly modes?:       { list(): readonly ModeOption[]; current(): string; set(id: string): Promise<void> }   // 后端原生模式词汇
  readonly compact?:     { run(): Promise<void>; cancel?(): void }
  readonly rewind?:      { preview?(anchor: string): Promise<RewindPreview>; rewind(anchor: string, mode: 'conversation' | 'files' | 'both'): Promise<RewindOutcome> }
  readonly fork?:        { fork(anchor?: string, title?: string): Promise<AgentSessionRef> }
  readonly subagents?:   { interrupt(agentId: string): Promise<boolean>; history?(agentId: string): Promise<readonly AgentEvent[]> }
  readonly tasks?:       { stop(taskId: string): Promise<boolean>; readOutput?(taskId: string): Promise<string> }
  readonly mcp?:         { status(): Promise<readonly McpServerView[]>; reconnect?(name: string): Promise<void>; toggle?(name: string, enabled: boolean): Promise<void> }
  readonly commands?:    { list(): Promise<readonly CommandInfo[]>; run?(name: string, rawInput: string): Promise<ExternalCommandOutcome | undefined> }
  readonly context?:     { usage(detail: 'summary' | 'full'): Promise<ContextUsageView> }
  readonly account?:     { info(): Promise<AccountView> }
  readonly loadedContext?: { snapshot(): Promise<LoadedContext | undefined> }
  readonly native: { readonly dsh?: DshNative; readonly claude?: ClaudeNative; readonly acp?: AcpNative }
}

// src/agent/backend.ts
export interface AgentBackend {
  readonly id: string                                  // 'dsh' | 'claude' | 'acp:<agent>'
  readonly descriptor: { label: string; vendor: string; version?: string; brand?: 'neutral' }
  detect(host: BackendHost): Promise<BackendDetection>  // installed/auth/version-drift；绝不抛
  open(target: OpenTarget, host: BackendHost): Promise<AgentSession>  // {kind:'create',cwd} | {kind:'resume',sessionId} | {kind:'fork',from,anchor?}
  readonly catalog?: SessionCatalog                   // list/info/preview/rename/delete（离线，不需要打开会话）
}
```

`DshNative`/`ClaudeNative` 是逃生舱：DSH 侧暴露 `agent`/`ctx`（给尚未 capability 化的 specialist），Claude 侧暴露 `query`（给 `/claude:*` 命令或诊断）。规则：**只有 `src/dsh-adapter/channel/*` 的 DSH specialist 可以读 `native.dsh`；只有 `src/backends/claude/*` 可以构造 `native.claude`；`src/channel/*` 与 UI 不得读 `native.*`**（门禁用正则扫描 `native.dsh`/`native.claude` 的引用目录）。

### 3.5 Channel 的最低职责与 DSH specialist 的挂载方式

Channel（组合根 + `src/channel/*`）只做六件事：

1. 持有一个 `AgentSession` 绑定（`binding.ts` 泛化：`Agent/AgentHandle` → `AgentSession`，prepare/adopt/switchTo 事务语义不变）；
2. 用 `session.history()` 回放、`session.subscribe()` 跟随，交给唯一 reducer `createChannelProjection`；
3. 维护 UI 视图模型 `ChannelState`（rows、tokens、spinner、pending、subagents、tasks、compaction、notifications…）；
4. 把 `ChannelUi` 动作委托给 `session.capabilities.*`，能力缺席时 `notify(t('capability-unavailable', {name}))` 并返回失败值（**不**静默 no-op，符合"未安装或已释放的动作明确失败"的既有约定）；
5. 输入管线（FIFO、@ 提及、图片、IDE 选区、`tui/input` 决策）与 `submit/steer/interruptAndDeliver` 的放置语义；
6. 宿主接缝（settings/scenes/themes/dialogs/notify）。

DSH specialist 挂载规则（Phase 4a 落地）：`createChannel(ctx, session, options)` = `createCoreChannel(ctx, session, options, owner)` →（`session.capabilities.native.dsh` 存在时）`attachDshExtensions(core, ctx, native.dsh, options)` → `core.start()`；三步在同一个 owner 事务里，任一步抛错全部回滚。核心对每个会话都一样：binding、输入管线、共享投影器、宿主接缝、IDE 选区、git 分支、`/export`（来自投影行）、`!cmd`（工作区目标）、通用 `/new`、按能力委托的动作；扩展经 `extend()` 钩入（DSH：同步种子回放、原始订阅者、作业喂入与峰谷计价、日志折叠恢复、`/new` 的 preset/路由/挂载预约/工作区归属 opener）并把自己的动作叠在核心之上，DSH specialist 继续通过 `native.dsh.agent/ctx` 工作，内部实现不变。Claude 会话下这些 specialist 不存在，对应的 `ChannelUi` 成员由 §5.3 的 capability 路径接管或明确不可用。新增后端不需要 channel 代码。

### 3.6 Source-of-truth 规则

| 事实 | 真源 | TUI 保存什么 |
| --- | --- | --- |
| DSH 会话 | DSH 会话事件日志（不变） | `~/.dsh-tui` 现有元数据 |
| Claude 会话 | `~/.claude/projects/<cwd>/<id>.jsonl`（CLI 写；SDK 读 API） | `~/.dsh-tui/backends/claude/last-used.json`、pins、颜色（**不**写转录；`renameSession`/`tagSession` 走 SDK） |
| 回放 | DSH：全量日志；Claude：`getSessionMessages({includeSystemMessages:true})`（= 模型可见链路） + 可选 `loadOlder` 读原生 JSONL 的压缩前历史（只读） | 无 |
| 权限状态 | 后端（Claude：CLI 的 session/settings 规则；DSH：permission presets） | 无 |
| 用量/费用 | 后端上报值优先（Claude `result.total_cost_usd/modelUsage` 标 `source:'backend'`；DSH 本地估算标 `source:'estimate'`） | 无 |

禁止：把 Claude 转录转成 DSH JSONL 作为主路径（`migrate/` 的导入功能保留为用户显式操作，不参与 Claude 后端）；在 TUI 内维护第二份会话索引（除非 §8 的基准证明 SDK list 太慢，届时用文件 mtime 索引缓存，仍以 SDK 为真源）。

### 3.7 Native extension 与 ACP 的层级

- 后端专属 slash 命令以命名空间暴露：`/claude:usage`、`/claude:plugins`、`/claude:mcp-auth <server>`；由后端的 `commands` capability 提供描述，Chat 的本地命令表不再硬编码它们。
- 后端的原生命令（Claude 的 65 个 `supportedCommands()`）作为"转发给后端的文本命令"合并进补全列表（标记 `origin:'backend'`），与本地命令同名时本地优先（现有规则）。
- ACP：`src/backends/acp/`，一个 `AcpBackend` 把 ACP `session/update` 翻译成同一 `AgentEvent`；缺失的能力表现为 `capabilities.*` 缺席；见 §7。

---

## 4. Claude 后端：经验证的接口契约（C）

### 4.1 传输选型：Agent SDK（主）/ `claude -p --output-format stream-json`（诊断）

| 维度 | `@anthropic-ai/claude-agent-sdk` | 自己维护 `stream-json` 进程协议 |
| --- | --- | --- |
| 官方地位 | SDK 每个版本声明与 Claude Code parity（`manifest.json`：0.3.287 ↔ 2.1.287）；`/core` 子入口为嵌入方优化 `[d.ts]` | CLI flag 同样官方，但 host 控制面（`control_request` 40+ 子类型：`initialize/can_use_tool/set_permission_mode/set_model/interrupt/rewind_files/mcp_*/stop_task/background_tasks/get_context_usage/…`）要自己实现序列化与配对 `[d.ts: SDKControlRequestInner]` |
| 已封装的难点 | 权限回调、hooks、in-process MCP、`interrupt()` 回执、会话 store API、`prewarm()`、进程优雅关闭（stdin EOF + 2s 宽限）`[d.ts: SpawnOptions.signal]` | 全部自己做 |
| 风险 | 版本漂移快（约每工作日一版） | 协议漂移同样快，且无类型 |

**裁定**：主实现 = Agent SDK（根入口 `@anthropic-ai/claude-agent-sdk`，不是 `/core`：我们需要 `listSessions/getSessionMessages/getSubagentMessages/forkSession/listSubagents`，而 `/core` 不含会话读取 helper `[README]`）。`stream-json` 只作为 `scripts/probes/` 的对照工具。

### 4.2 安装、二进制与版本漂移策略

- **依赖形态**：`@anthropic-ai/claude-agent-sdk` 作为 **optional peerDependency**（`peerDependenciesMeta.optional`）+ devDependency，后端用动态 `import()`。理由：SDK 携带平台二进制 optional deps（linux-x64 包约 230MB）`[manifest.json]`，不能让每个 DSH 用户的 profile 安装都付这个代价。安装入口：`dsh-tui backend install claude`（在 profile 目录执行 `pnpm add @anthropic-ai/claude-agent-sdk@<pinned>`），`detect()` 未找到时在 Launchpad/`/backend` 给出该命令。
- **可执行文件**：优先用户 PATH 上的 `claude`（与其交互式 CLI 同版本、同会话库；`[P1]` 用 `/home/coder/.local/bin/claude` 跑通），其次 SDK 自带二进制（`@anthropic-ai/claude-agent-sdk-<platform>`），用 `pathToClaudeCodeExecutable` 显式传入；`CLAUDE_CODE_EXECUTABLE` 环境变量可覆盖（与 `[acp]` 一致）。
- **版本契约** `src/backends/claude/contract.ts`：`VALIDATED_SDK_VERSION = '0.3.287'`（精确 pin，如 `[acp]` 对 0.3.286 的做法）；`VALIDATED_CLI_VERSIONS = ['2.1.287']`（从 `system/init.claude_code_version` 读）。超出范围：启动横幅 warning + `/doctor` 报告，不阻断；CI 的 `verify:claude-contract` 在 SDK 版本与 pin 不一致时失败（镜像 `verify:contract` 的做法，但不复制 DSH 预发布多版本矩阵）。
- **能力探测优先于版本判断**：读 `system/init.capabilities`（`[P1]` 本机：`interrupt_receipt_v1 interrupt_cancel_queued_v1 interrupt_send_now_v1 msg_lifecycle_v1 sdk_mcp_tools_list_changed sdk_mcp_manifests mcp_read_resource_v1 mcp_tool_ui_meta_v1 …`），把 `ClaudeNative.capabilities` 暴露给翻译器；`OPTION_REBUILDS_SESSION satisfies Record<keyof Options, boolean>` 式的编译期穷举（`[acp]`）用于在 SDK 增删 Option 时让 `tsc` 报错。
- **Node**：SDK `engines.node >= 18`；本仓库 `^22.19 || >=24`，无冲突。

### 4.3 Claude Code Fidelity Profile：`query()` 选项逐项裁定

目标：同一项目下 `claude` 与 `dsh-tui`（Claude 后端）核心行为一致。来源标注见 §1。

| Option | 值 | 理由 / 证据 |
| --- | --- | --- |
| `prompt` | `AsyncIterable<SDKUserMessage>`（Inbox，见 §4.4） | 一条会话一个 query；`[acp]` 同 |
| `cwd` | 会话 cwd（绝对路径） | `[d.ts]` |
| `systemPrompt` | `{ type:'preset', preset:'claude_code' }`（**不**加 `append`，不设 `snapshot`，让 CLI 默认 `snapshot:true`） | 保真；`[P1]` 验证 CLAUDE.md 生效；`[d.ts]` 说明 `append` 会被记录进会话 |
| `settingSources` | `['user','project','local']` | 必须含 `project` 才加载 CLAUDE.md `[d.ts]`；`[P1]` 验证 |
| `tools` | `{ type:'preset', preset:'claude_code' }` | 保真；`[P1]` init.tools 33 项 |
| `permissionMode` | TUI 当前模式（启动值 = `filterEscalatingDefaultMode(await resolveSettings({cwd, settingSources})).permissions?.defaultMode ?? 'default'`） | `[P2]` 省略得到 `default`；但 d.ts 说可能是 `auto`；显式传最稳 |
| `allowDangerouslySkipPermissions` | 仅当用户显式选择 `bypassPermissions` 模式且非 root（`[acp]` `ALLOW_BYPASS = !IS_ROOT || IS_SANDBOX`） | `[d.ts]` 要求 |
| `canUseTool` | §4.7 桥 | 必填，否则 `ask` 决策在无提示面时终结为拒绝 `[d.ts: SDKPermissionDeniedMessage 注释]` |
| `permissionPrompts` | 省略（= `'host'`） | |
| `includePartialMessages` | `true` | 流式 |
| `forwardSubagentText` | `true` | 子代理卡片需要正文 `[d.ts]` |
| `perTaskStopAffordance` | `true` | 让 `interrupt()` 不杀后台任务；TUI 提供逐任务 stop `[d.ts]` |
| `enableFileCheckpointing` | `true` | `rewindFiles` 需要 `[P1]` dryRun 成功 |
| `includeHookEvents` | `false` | 噪音 |
| `env` | `{ ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-tui/<version>', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }`，并**删除** `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_*`，以及（Phase 2 评审补充）`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ATTENDED`（CLI 启动时读取，会把子进程当成父会话的 child session）、`CLAUDE_PID`、`AI_AGENT`、`TRACEPARENT`、`CLAUDE_CODE_EXECPATH`、`CLAUDE_EFFORT`、`CLAUDE_CODE_INVOKED_SKILLS`（dsh-tui 本身可能运行在 Claude Code 终端里，`[P1]` 本机 env 即如此） | `env` **整体替换**子进程环境 `[d.ts]`；`session_state_changed` 在 2.1.88 源码里受该 env 门控 `[hist]`，`[acp]` 亦设置。**实测修正 (Phase 0, P3-1)**：设置该 env 后 CLI 2.1.287 发出 `system/session_state_changed`（未设置的 P1/P2 一次都没有）：`running` 在 idle→running 时发、早于 `command_lifecycle queued`；`idle` 在 `result` 与 `command_lifecycle completed` 之后 0–5ms；背靠背的 turn 之间不回 `idle`。保留该 env；`requires_action` 本次未触发（工具被 CLI 规则直接放行，没走 `canUseTool`），留给 Phase 3 权限探针 |
| `pathToClaudeCodeExecutable` | §4.2 | |
| `stderr` | 回调 → `logForDebugging` + 去重后 `notify`（复用 `childStderr.ts` 的 reporter） | TUI 渲染期 stdout/stderr 必须安静（AGENTS.md 红线）；子进程 stderr 若继承会污染 alt-screen |
| `model` | 省略（跟随 settings.model）或 TUI 持久化的 `/model` 选择 | 保真 |
| `effort` | 省略（跟随 settings/modelSettings）或 TUI `/effort` 选择 | `[d.ts] EffortLevel` |
| `thinking` | 省略 | 跟随用户设置 |
| `mcpServers`/`strictMcpConfig`/`plugins`/`agents`/`skills` | 省略 | 全部由 CLI 按 settings/.mcp.json/plugins 加载（`[P1]` init 列出 claudeai 代理 MCP、builtin plugins、5 个 agents、30 个 skills） |
| `hooks` | 省略 | 用户 settings 中的 hooks 由 CLI 执行；TUI 不需要进程内 hook（`[P1]` SessionStart 回调未触发，不依赖它） |
| `onElicitation` | 实现（form/url → QuestionStore / 打开 URL 提示） | `[d.ts]` 缺省会自动 decline |
| `onUserDialog`+`supportedDialogKinds` | Phase 5：`['refusal_fallback_prompt']`；之前省略（fail closed） | `[d.ts]` |
| `resume` / `forkSession` / `sessionId` / `resumeSessionAt` / `resumeDropsTurn` | 见 §4.12 | |
| `title` | 省略（CLI 自动标题）；`/rename` 走 `renameSession()` | `[P2]` `title` 触发 `session_title_changed` |
| `abortController` | 每会话一个；`dispose()` 时 `close()` 后再 abort | `[d.ts]` 优雅关闭顺序 |
| `promptSuggestions`/`agentProgressSummaries`/`verbatimPrompts`/`outputFormat`/`maxTurns`/`maxBudgetUsd`/`sandbox`/`settings`/`managedSettings`/`sessionStore`/`extraArgs`/`betas`/`toolAliases`/`projectConfigRoot`/`additionalDirectories` | 省略（`additionalDirectories` 由 `/add-dir` 本地命令映射，Phase 5） | |

### 4.4 会话生命周期与 turn 模型（streaming-input）

```text
ClaudeAgentSession.open()
  ├ detect: 可执行文件 / SDK 版本 / 凭证状态（不读凭证内容）
  ├ q = query({ prompt: inbox, options })            // 立即返回 Query（AsyncGenerator）
  ├ init = await q.initializationResult()            // commands/agents/models/account/current_permission_mode …  [P1]
  ├ consumer loop: for await (m of q) → translate(m) → emit(batch)
  └ capabilities 绑定到 q（setModel/applyFlagSettings/setPermissionMode/interrupt/stopTask/rewindFiles/mcp*/getContextUsage/accountInfo）

submit(text) → inbox.push({type:'user', message:{role:'user',content}, parent_tool_use_id:null, session_id:'', uuid: clientMessageId})
  ├ `command_lifecycle{command_uuid: uuid, state:'queued'}`  [P1]           → pending.changed
  ├ `state:'started'`（[acp] 全集 queued|started|completed|discarded|refused|cancelled）→ turn.start{origin:'user', userMessageId}
  ├ `system/init`（每 turn 重发 [P1]）→ 更新 model/permissionMode/commands（不开新 turn）
  ├ `system/status{status:'requesting'}` → spinner requesting
  ├ stream_event message_start → assistant.attempt.start（attemptId=message.id；`user_message_uuid` 用于归属）
  ├ … deltas / assistant 分块消息 / user(tool_result) …
  ├ `result` → turn.end（权威）；随后仍可能有 task_notification / session_state_changed  [d.ts result 注释]
  └ `system/session_state_changed{state:'idle'}`：仅当设置 env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`（[acp] 这样做；本仓库 Phase 2 探针 P3-1 验证是否需要）作为"无 result 的兜底"
```

> **实测修正 (Phase 0, P2-1)**：`command_lifecycle` 实测状态 `queued`/`started`/`completed`/`cancelled`（未见 `discarded`/`refused`）。
> 用户发起的 turn：`queued` → `started`（+2–8ms）→ 本 turn 的 `system/init`（`started` 之后 13–28ms，冷启动首个 turn 462ms）→
> `system/status{requesting}` → 首个 `stream_event` → … → `result` → `completed`（`result` 之后 0–5ms）。即 **`started` 早于每 turn 的 `init`**，
> 以 `started` 开 turn 成立。但 `started` 不总是新 turn：被 `priority:'next'` 并入运行中 turn 的消息，在工具轮次结束后才 `started`，
> **不重发 `init`**、turn 继续，该消息也**没有** SDK `user` 回显；它的 `completed` 比 `result` 早约 3ms，`result.user_message_uuids` 列出该 turn
> 并入的全部 uuid（`user_message_uuid` 为首条）。被 `now` 中断的 turn，其已 `started` 的命令在中断后的 `result` 之后收到 `cancelled`。

规则：

- **turn 的开启**：翻译器在"没有打开的 turn"时收到以下任一消息即开 turn：`command_lifecycle.started`（origin user，带 userMessageId）、`system/status requesting`、`stream_event message_start`、`assistant`。系统发起的 turn（`result.origin.kind ∈ task-notification|peer|coordinator|observer|…` `[acp]`）标 `origin:'notification'`，UI 在 user 行位置渲染一条 `notice`（"后台任务完成，模型继续处理"），而不是伪造用户气泡。**实测修正 (Phase 0)**：turn 已打开时收到的 `started` 是"并入当前 turn"，只落用户行、不开新 turn。
- **turn 的关闭**：`result`。`subtype:'success' && !is_error` → completed；`terminal_reason ∈ {aborted_streaming, aborted_tools}` → aborted（`[P1][P2]`，此时 `subtype:'error_during_execution'`，`errors` 含 `[ede_diagnostic]…`，**不**当错误显示）；`is_error` 其他 → error（`result` 文本是错误消息）；`error_max_turns/_budget_usd/_structured_output_retries` → blocked。**实测修正 (Phase 0, P3-3)**：`priority:'now'` 中断的 turn 以 `result{subtype:'success', is_error:false, terminal_reason:'aborted_streaming'|'aborted_tools'}` 结束（`interrupt()` 才是 `error_during_execution`），且不发 `[Request interrupted by user]` 回显——**先判 `terminal_reason`，再判 `subtype`**，否则会被当成 completed。
- **pending 队列**：以 `command_lifecycle` 为准；`interrupt()` 回执 `still_queued`（`[P1]`）校正；`removePending` 在 `interrupt_cancel_queued_v1` 可用时调 `interrupt({cancel_queued:true})`（`[d.ts]`），否则提示不支持（SDK 公共 API 未暴露 `cancel_async_message`——施工探针 P3-2 确认 `Query` 上是否有未声明方法，否则 `removePending` 返回 false）。**实测 (Phase 0)**：0.3.287 运行时 `Query` 原型上有未声明的 `cancelAsyncMessage`（只列举、未调用；签名与回执留给 Phase 3 探针）。
- **submit 放置语义映射**（`SDKUserMessage.priority: 'now'|'next'|'later'` `[d.ts]`；2.1.88 源码 `[hist]`：`now` 中止进行中的工作、`next` 在下一个工具轮次后并入当前 turn、`later` 等 turn 结束）：`turn` → 普通 push；`steer`（DSH 的"下一步边界"语义）→ `priority:'next'`；`followup` → `priority:'later'`；`now`（`interruptAndDeliver`）→ `priority:'now'`（或 `await q.interrupt()` 后 push，二选一由探针 P3-3 决定）。注意 `[acp]` 用 `now` 做 steering，且 2.1.286 起 steer 会把正在前台运行的工具转后台——施工前必须用 P3-3 确认 `next` 的现行语义。
  **实测修正 (Phase 0, P3-3，CLI 2.1.287 / haiku)**：`next` 在前台工具运行时发送 → 工具照常跑完，消息在该工具轮次后**并入同一 turn**（无新 `init`，一个 `result`、`num_turns:3`，模型照做），与 DSH steer 的"下一步边界"一致，`steer → next` 成立；`next` 在纯文本流式（无后续工具轮次）时发送 → 当前 turn 正常完成，消息随后作为**独立新 turn** 运行（此时等同 followup）。`now` 在文本流式时发送 → 约 10ms 内中断（`assistant.aborted:true` 带已流出的前缀，`aborted_streaming`，原命令 `cancelled`），随即以 `now` 消息开新 turn；`now` 在前台 Bash 运行时发送 → **既不杀也不转后台**该工具（`task_started.is_backgrounded:false`），等它跑完（本次 6.6s）后以 `aborted_tools` 结束、原命令 `cancelled`、计划中的下一个工具不再执行，再开新 turn。裁定：`now`（`interruptAndDeliver`）→ `priority:'now'`（一次原子操作，lifecycle 报告被取消的命令）；代价是前台工具期间的投递延迟 = 工具剩余时长，若 Phase 2 手动演练不可接受，再探 `interrupt()` 对前台工具的效果。未观察到"steer 把前台工具转后台"。
- **用户行的落地时机**：不乐观插入。以 `command_lifecycle.started`（需 `msg_lifecycle_v1`）为准；CLI 不支持时退回 `extraArgs: { 'replay-user-messages': '' }` 让 CLI 回显我们的消息（`SDKUserMessageReplay{isReplay:true, uuid}` `[d.ts][acp]`），以回显为准。
- **idle 兜底与强制取消**：`[acp]` 经验——`idle` 可能滞后到下一 turn 的回显之后（#773），被打断的 turn 可能永远没有 `result`（#825），`query.next()` 可能挂起（#680）。TUI 采用：`cancel()` 后 30s 内未见 `result`/`idle` → 投影器强制 `turn.end{aborted}` + `notice`，并把会话标为 `requires-action`。
- **多会话/parked**：每个 Claude 会话 = 一个 CLI 子进程（约 230–260MB `[d.ts prewarm 注释]`）。`agent-view`/`/bg` 的"进程内后台会话"对 Claude 有效但有上限：`ClaudeBackend.limits.maxLiveSessions = 3`（可配置），超出时 `parked` 会话改为 `close()` 并在再次 attach 时 `resume`（历史从 store 回放）。

### 4.5 流式细节

- `stream_event.event` 是 Anthropic Messages 流事件：`message_start`（含 `message.usage` 的 input/cache 计数与 `model`）→ `content_block_start{index, content_block:{type: thinking|text|tool_use|…}}` → `content_block_delta{delta: thinking_delta|signature_delta|text_delta|input_json_delta}` → `content_block_stop` → `message_delta{delta.stop_reason, usage}` → `message_stop` `[P1]`。`ttft_ms` 在 `message_start` 上 `[P1]`。
- **thinking 三态**：(a) 有正文（`thinking_delta.thinking` 非空）→ reasoning 行流式；(b) 无正文只有 `estimated_tokens`/`system/thinking_tokens` → reasoning 行显示"思考中 · ~N tokens"（`assistant.delta{kind:'reasoning-tokens'}`），settle 时若 `assistant.message` 的 thinking 块仍为空则把该行折叠成一行摘要"已思考 N tokens"；(c) 无 thinking 块。`signature_delta`、`citations_delta` 忽略。
- **assistant 分块**：同一 `message.id` 的多条 `assistant` 分别只含一个块（`[P1]`）。翻译器以 `message.id` 为 attempt，把每个块作为 `assistant.message`（`canonical:true`）的增量块累积：文本块 settle 文本行；`tool_use` 块产生 `tool.call`（`callId=tool_use.id`，`argsJson=JSON.stringify(input)`，`caller.type` 忽略）；thinking 块 settle reasoning 行。turn 内 step = `message_start` 计数。
- **流式 tool 参数**：`input_json_delta.partial_json` 累积为 `assistant.delta{kind:'tool-args'}`，供工具卡在 `content_block_start:tool_use` 后就显示（名称已知）并在 `assistant` 消息到达时用完整 `input` 替换（`[acp]` 的 lexer 做法可选；Phase 2 只在 start 时建卡、在 assistant 消息时填参数）。
- **去重**：若未开启 partial 或网关不流式，`assistant` 消息可能携带未流过的文本 → 投影器以 `assistant.message.canonical` 文本覆盖行文本（现有 DSH 逻辑 `if (text || canonical) row.text = text` 已覆盖）。
- **中断**：`assistant.aborted:true` + `user "[Request interrupted by user]"` + `result aborted_streaming` `[P1]` → 投影器把流中的行 settle 并追加 `interrupt` 行（复用 DSH 的 `interrupted-by-user` 行）；`[Request interrupted by user…]` 这类 user 文本**不渲染**为用户气泡（翻译器识别前缀 `[Request interrupted by user`）。

### 4.6 工具结果

- 工具结果以 `user` 消息到达：`message.content[{type:'tool_result', tool_use_id, content: string|blocks, is_error?}]` + 顶层 `tool_use_result`（结构化，按工具不同）+ `tool_result_meta[{id, non_execution_kind:'permission-rule'|'user-rejected', user_feedback?}]`（`[P2]`，d.ts 未声明，按 unknown 收窄）。
- `tool.result.structured = tool_use_result`，由 `src/backends/claude/tools.ts` 的 presenter 读取生成 `ToolResultView`：
  - `Read` → `{card:'read', path, content}`（`file.content` 带行号）；
  - `Write` → `{card:'diff', diffs:[{path, oldText: originalFile ?? null, newText: content}]}`；`Edit`/`MultiEdit` → 从 `tool_use_result.structuredPatch`（hunks）或 `old_string/new_string` 构造 `diffs`（`[acp] diff.ts` 的 hunk → 文本策略；注意 CLI 会规范化 tab/CRLF，不要拿 hunk 生成 git patch）；
  - `Bash`/`PowerShell` → `{card:'terminal', output: stdout + stderr, exitCode: is_error ? 1 : 0, signal}`，`interrupted` 追加 `[aborted]`；`backgroundTaskId` → `task.start{kind:'shell', background:true}`；
  - `Glob` → `{card:'search', shape:'paths'}`；`Grep` → `{card:'search', shape:'matches'}`（解析 `content` 文本的 `path:line:text`；`[acp] search.ts`）；
  - `WebFetch`/`WebSearch` → `generic`（标题含 URL/查询）；
  - `Agent`/`Task` → 不建工具卡，建 `subagent.start`（§4.8）；
  - `AskUserQuestion`/`ExitPlanMode`/`EnterPlanMode` → 不建卡（§4.7）；
  - `TodoWrite` → `todo.write`（`input.todos[{content,status,activeForm}]`，status `pending|in_progress|completed`），不建卡；
  - `Skill` → generic 卡 `Load skill: <name>`；`mcp__<server>__<tool>` → generic 卡，标题 `server › tool`；未知 → generic。
- 工具名 → 显示名：新增 i18n `tool-name-*` 条目（`read write edit multiedit notebookedit bash powershell glob grep webfetch websearch agent skill todowrite`），`AssistantToolUseMessage.tsx` 的 `TOOL_NAME_KEYS` 改为由后端 presenter 提供 `displayKey`（通过 `ToolPresentation.displayKey`），颜色分类（mutate/exec/other）同样由 presenter 给出。

### 4.7 权限桥（canUseTool / AskUserQuestion / elicitation / dialog）

```text
CLI ──can_use_tool──▶ SDK ──canUseTool(toolName, input, opts)──▶ ClaudeAgentSession.permissions
                                                                   │ emit permission.request{requestId: opts.requestId, callId: opts.toolUseID, …}
                                                                   │ 挂起 Promise，登记到 pending Map<requestId, {resolve, signal}>
  Chat 审批面板（PermissionStore，FIFO）◀── channel ◀────────────────┘
  用户决定 ──▶ session.capabilities.permissions.respond(requestId, decision) ──▶ resolve(PermissionResult)
```

- **请求视图** `PermissionRequestView`：`{ requestId, callId, toolName, input, displayName?, description?, title?, reason?: decisionReason, blockedPath?, agentId?, defaultToNo?, suppressAlwaysAllow?, matchedAskRule?, mcpServer?, options: PermissionOption[] }`；`options` 由后端生成（`[acp] permissions/options*`）：`allow-once`；`allow-always`（仅当 `suggestions` 非空且 `!suppressAlwaysAllow && !matchedAskRule`，label 按建议类型：`addRules`→"本次会话/本项目不再询问 <规则>"、`setMode acceptEdits`→"自动接受编辑"、`addDirectories`→"允许访问 <dir>"）；`reject`。`defaultToNo` 时 reject 居首且无单键确认。
- **决定 → PermissionResult**：allow-once `{behavior:'allow', updatedInput: input, toolUseID}`；allow-always `{behavior:'allow', updatedInput: input, updatedPermissions: suggestions, toolUseID, decisionClassification:'user_permanent'}`（持久化**完全交给 CLI**：`destination` 为 `session|localSettings|…` 由建议决定；TUI 不写 settings 文件）；reject `{behavior:'deny', message:'User refused permission to run tool', toolUseID, decisionClassification:'user_reject'}`（可附用户反馈文本 → `message`）。
- **AskUserQuestion**：`canUseTool` 收到 `toolName==='AskUserQuestion'`（`opts.requiresUserInteraction:true` `[P2]`）→ 不进审批面板，转 `question.request`（`input.questions[{question, header, options[{label,description}], multiSelect}]` → 现有 `QuestionStore` 的 `questions[{id, question, header, options, multiSelect}]`，id = 索引）；答案 `{behavior:'allow', updatedInput:{...input, answers:{[question]: 'label' | 'a, b'}}}`（多选逗号连接 `[acp]`；自定义文本直接作为答案）；取消 → `{behavior:'deny', message:'User cancelled the question', interrupt:true}`。`ExitPlanMode`：作为审批请求但走现有 `PlanReviewPanel`（intent `plan-review`），approve → allow + `updatedPermissions:[{type:'setMode', mode:'acceptEdits'|'default', destination:'session'}]`；reject with feedback → deny + `interrupt:true`（`[acp]`）。
- **死锁防护**（必须测试矩阵，§8.4）：
  1. `opts.signal` abort（CLI 取消：`interrupt()`、turn 结束、进程退出）→ 从 pending 移除、面板关闭、`permission.settled{outcome:'cancelled'}`；`[P2]` 验证 signal 立即触发且 CLI 自动写拒绝结果；
  2. 用户 `cancel()`（Ctrl+C/Esc 中断 turn）→ 先 `interrupt()`（触发 1），不自己 resolve；
  3. 面板被 dismiss（Esc）→ 等同 reject（现有 `ApprovalPanel` 行为）；
  4. `dispose()`/会话切换 → 对所有 pending resolve `deny` 后 `q.close()`；
  5. 多个并发请求（并行工具调用）→ FIFO，面板一次一个（现有 `ApprovalStore` 语义）；子代理请求带 `agentId`，面板显示来源；
  6. 回调抛异常 → SDK 侧视为 deny；翻译器 try/catch 保证不抛。
- **`permission_denied` 系统消息**（`[d.ts]`）：自动拒绝（auto 分类器/dontAsk/规则）→ `notice{level:'warning', callId}` 并把工具卡标 error（`decision_reason`）。
- **模式**：`modes` capability 列表 = `default|acceptEdits|plan|auto|bypassPermissions(仅 allowBypass)`（`dontAsk` 不提供）；`set` → `q.setPermissionMode()`，确认来自 `system/status{permissionMode}`（`[P1]`）→ `mode.changed`。Shift+Tab 循环对 Claude = `default → acceptEdits → plan → default`（`auto` 需模型 `supportsAutoMode` `[P1] supportedModels`）。
- **MCP elicitation**：`onElicitation` form → QuestionStore（JSON schema 转问题：string/enum/boolean 字段各一题，其余作为自定义文本）；url → `notice` + 复制链接提示，返回 `{action:'accept'}`；不支持的 → `{action:'decline'}`。

### 4.8 子代理与后台任务

| 信号 | 翻译 |
| --- | --- |
| `assistant`/`user`/`stream_event`/`tool_progress` 带 `parent_tool_use_id` | 子代理通道：`parentCallId`；`subagent.start` 若尚未见到 `task_started` 则用 `tool.call(Agent)` 的 `description/subagent_type` 预建（`[P1]` tool_use 先于 task_started 到达） |
| `system/task_started{task_type:'local_agent', task_id, tool_use_id, subagent_type, description, prompt, is_backgrounded, spawn_depth}` | `subagent.start{agentId: task_id, parentCallId: tool_use_id, kind: subagent_type, background}` |
| `system/task_progress{usage{total_tokens,tool_uses,duration_ms}, last_tool_name, summary}` | `subagent.progress` |
| `system/task_updated{patch{status,...}}` | `subagent.progress`/`task.update` |
| `system/task_notification{status, summary, usage, output_file}` | `subagent.end`（status completed/failed/stopped→cancelled）或 `task.end` |
| `system/task_started{task_type:'local_bash'|'local_workflow'|…}` | `task.start{kind: shell|workflow|monitor, command: description, background: is_backgrounded, outputFile}`。**实测修正 (Phase 0)**：前台 Bash 跑满约 3s 也会发 `task_started{is_backgrounded:false}`，结束时发 `task_notification{status:'completed', output_file:''}`；`is_backgrounded:false` 的不建后台任务卡（只作工具卡的 `tool.progress`），否则每条稍慢的命令都会冒出 jobs chip |
| `system/background_tasks_changed{tasks[]}` | `tasks.snapshot`（REPLACE 语义；缺席的子代理/任务若无 end 事件则标 `unknown`） |
| `tool_progress{tool_use_id, elapsed_time_seconds, parent_tool_use_id, subagent_type, subagent_retry}` | `tool.progress`（心跳 id `*-heartbeat-*` 忽略 `[acp]`） |
| hooks `SubagentStop{agent_id, agent_transcript_path}` | 不依赖（我们不注册 hooks）；resume 时用 `listSubagents + getSubagentMessages` |
| `Agent` 工具的 `user(tool_result)`（`tool_use_result.isAsync/status:'async_launched'/agentId`） | 子代理卡的"启动"态；最终报告在 `task_notification.summary` |

UI 映射：`subagent.*` → 现有 `SubagentActivityStore`/`SubagentRow`/`SubagentCard`/`SubagentDashboard`（字段 `agentId, description, model(resolvedModel), status, startedAt, outputEvents(text/thinking/tool), toolCalls, tokens(total), summary`）；`task.*` → 现有 `BackgroundJobStore`/`JobsPanel`/状态栏 chip（`id, kind:'shell', label, command, status, outputLines`），`tasks.stop` → `q.stopTask(taskId)`；`readOutput` → 读 `outputFile`（受 `~/.claude` 路径限制，只读）。turn 结束时若 `tasks.snapshot` 非空，状态栏保留"后台 N 任务"chip（现有 jobs chip）。

**Phase 5a 实测修正与裁定**：
- 子代理通道只有完整消息（`forwardSubagentText` 下没有子代理的 `stream_event`）；翻译器把它们译成带 `parentCallId` 的 `assistant.message`/`tool.call`/`tool.result`/`tool.progress`，由中立的 `src/channel/activity.ts` 收进卡片与面板，绝不进主转录。`Agent`/`Task` 调用即发 `subagent.start{agentId: callId}` 预建，`task_started` 以同一 lane 发第二个 `subagent.start{agentId: task_id, depth}` 补全并重键。
- 后台 Bash 的 `task_started` **没有** `output_file`；路径在命令确认文本（"Output is being written to: …"，伴随 `tool_use_result.backgroundTaskId`）与 `task_notification.output_file` 里 → `task.update{outputFile}` / `task.end{outputFile}`。尾部只读这个 CLI 报告的路径并校验（`<taskId>.output`、解析符号链接后仍在临时目录/`/tmp`/配置目录内、普通文件、`O_NOFOLLOW`），最后 64 KiB，卡片/面板在屏时每秒至多一次。
- `background_tasks_changed` 先于对应的 `task_updated`/`task_notification` 到达：缺席即推断落定（任务 killed+"状态未知"、子代理 `unknown`，无提示），随后的真实结束仍覆盖并只提示一次。任务卡详情只取退出码（`exit code: N`）——CLI 的整句报告做固定列会把标签挤成一字一行。
- 回放：子转录内容作为同一 lane 的事件插在父调用之后；终态取主链里的父结果（hand-back 报告 + `<usage>`、`is_error`→failed、中断→cancelled）或 `<task-notification>`（后台），都没有→`unknown`。
- 用户中断（`interrupt`）不停后台任务（`perTaskStopAffordance`，live 实测）；停止走 `stopTask(taskId)`，CLI 以 `stopped` 通知确认。

### 4.9 MCP / commands / skills / settings / CLAUDE.md

- MCP：`system/init.mcp_servers[{name,status,source}]` + `q.mcpServerStatus()`（`[P1]` 含 `tools[]`、`needs-auth`）→ `/mcp` 报告（替换 DSH 的 `tools.schemas()` 解析）；`reconnect/toggle` capability 对应 `q.reconnectMcpServer/toggleMcpServer`；`needs-auth` 的服务器显示提示"在 `claude /mcp` 里完成授权"（`mcpAuthenticate` 未在 d.ts 声明，不使用）。
- 命令：`q.supportedCommands()` 65 项（54 builtin，`[P1]`），`terminal_slash_commands`（`doctor color focus reload-plugins`）不进菜单；用户输入 `/name args` 若本地命令表没有、后端命令表有 → 作为 prompt 文本原样发送（CLI 内部分发，`[P2]` `/compact` 验证）；`commands_changed` → 刷新。本地命令与 Claude 同名冲突（`compact clear model effort mcp rename init doctor context agents usage`）：本地优先，但本地实现对 Claude 会话委托给 capability（例如 `/compact` → `compact.run()` = 发送 `/compact` 文本并以 `compact_boundary` 为确认；`/model` → `models.set` = `q.setModel`）。
- Skills：`init.skills[]` + `supportedCommands()` 中非 builtin 项 = `/skills` 列表（`SkillInfo{name, description, userInvocable:true, source:'claude'}`）。
- Settings/CLAUDE.md：全部由 CLI 加载；`/context` 面板用 `q.getContextUsage({detail:'summary'})`（`[P1]` 返回 categories/memoryFiles/mcpTools/skills/systemPromptSections）替代 DSH 的 `loadedContext` 组装。

### 4.10 model / effort / mode 控制

- 模型目录：`initializationResult().models` / `q.supportedModels()` → `ModelOption{ id: value, resolvedId: resolvedModel, label: displayName, description, supportsEffort, effortLevels, supportsAutoMode }`（`[P1]` 12 项：default/opus/fable/sonnet/haiku/全名…）；`/model` 对 Claude 不需要 provider 段（`ModelRef{provider?:undefined, model}`）；`models.set` → `q.setModel(value)` 原地切换（不 fork），确认来自后续 `message_start.model` 或 `assistant.message.model`（`[P2]`）→ `model.changed`；`PostModelSwitch`/`model_refusal_fallback` 不注册 hook，用 `system/model_refusal_fallback` 消息 → `model.changed{source:'fallback'}` + notice。
- effort：`ModelInfo.supportedEffortLevels` → `EffortOption[]`；`effort.set` → `q.applyFlagSettings({ effortLevel })`（`null` 恢复默认）；当前值来自 `init.effort`（d.ts 注明 Remote Control/headless per-turn init 携带；`[P1]` 本机 init 未见该字段 → 以 TUI 自己的选择为显示值，标 `source:'tui'`）。
- 模式：§4.7。
- 费用：`result.total_cost_usd`（query 内累计）与 `modelUsage[model].costUSD/contextWindow` `[P1]` → `costReport{currency:'USD', amount, source:'backend'}`；`contextWindow` 来自 `modelUsage[model].contextWindow`（200000 `[P1]`）→ `context.capacity`。
- 用量：每个 `message_start`/`message_delta` 的 `usage{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}` → `assistant.message.usage{input, output, cacheRead, cacheWrite}`（与 DSH 同义：**最近一次请求的 input+cacheRead+cacheWrite 即当前上下文占用**）；状态栏公式不变。`rate_limit_event.rate_limit_info{status, rateLimitType, utilization, resetsAt, unifiedWindows?}` → `rate-limit` → 状态栏 hover 面板"订阅用量 5h/7d"。

### 4.11 会话：create / resume / list / fork / rewind / rename / delete / compact

| 动作 | 实现 | 证据 |
| --- | --- | --- |
| create | `query({prompt: inbox, options:{cwd, sessionId?: randomUUID()}})`；用显式 `sessionId` 让 TUI 在 `init` 之前就知道 id（`[d.ts]`：不与 resume 同用） | |
| resume | `query({prompt: inbox, options:{resume: id}})` + 并行 `getSessionMessages(id, {dir: cwd, includeSystemMessages:true})` → `replay.ts` 翻译为 AgentEvent（`replay:true`）；子代理：`listSubagents(id,{dir})` → 对每个 `getSubagentMessages`（在父 `tool.call(Agent)` 之后插入） | `[P2]` resume 不回放；`[P1]` 读 API 形状 |
| 压缩前历史 | `getSessionMessages` 只给当前链路（`[P2]`）；`loadOlder()` 对 Claude = 用 `migrate/parse/jsonl.ts` + 简化版 `claude-code.parse.ts` 读原生 JSONL 的 `parentUuid` 链前段（只读）→ 追加到 rows 顶部（Phase 5）。**文件定位**：不要自己计算项目目录名（非字母数字→`-`，超过 200 字符后缀哈希，且 Bun 与 Node 的哈希不同 `[hist]`），改为在 `$CLAUDE_CONFIG_DIR ?? ~/.claude/projects/*/<sessionId>.jsonl` 中按 sessionId 扫描（复用 `migrate/adapters/claude-code.ts` 的 walk） | |
| list | `listSessions({dir: cwd, includeProgrammatic: false})` → `SessionSummary{id, kind:'root', title:{text: customTitle ?? summary, source: customTitle?'renamed':'auto'}, cwd, createdAt, updatedAt: lastModified, bytes: fileSize, branch: gitBranch, model?}`；"全部项目"视图用 `listSessions()`；`[P1]` 8 会话 21ms；施工 Gate 要求 500 会话基准 ≤ 300ms，否则加 mtime 索引缓存 | |
| preview | `getSessionMessages(id,{dir, limit, offset})` 尾部 | |
| rename | `renameSession(id, title, {dir})`（写 `custom-title` 记录）；live 会话额外 `session.title` 事件 | `[d.ts]` |
| delete | `deleteSession(id,{dir})` | |
| fork (`/fork`) | `forkSession(id,{dir, title})` → 新 id（`[P2]` 17ms）→ 不切换（与 DSH `/fork` 语义一致：生成持久副本） | |
| rewind（双击 Esc 选用户消息行） | 1) `mode ∈ files|both`：`q.rewindFiles(anchorUuid)`（先 `dryRun` 展示 `filesChanged/insertions/deletions` `[P1]`）；2) `mode ∈ conversation|both`：`forkSession(id,{dir, upToMessageId: <该用户消息的前一条消息 uuid>})` → `open({kind:'resume', sessionId: forkId})` 替换当前会话（与 DSH rewind 的"fork + 切换"语义一致）；返回被回退的用户文本供编辑。`resumeSessionAt`+`resumeDropsTurn` 作为备选（d.ts 的 refusal 语义复杂，首版不用） | |
| compact | `compact.run()` = push 文本 `/compact`；`system/status{status:'compacting'}`→`compaction.start`；`compact_boundary` → `compaction.end{ok, preTokens, postTokens}` + 合成 user 消息（`isSynthetic`）→ `user.message{source:'compaction'}`（投影为 `compact` 行，复用 DSH 的 `compact-done` 行与上下文计数重置）；`status{compact_result:'failed'}` → `compaction.end{ok:false}`；`local_command_output`/`<local-command-stdout>` 回显不渲染 | `[P2]` |
| 自动压缩 | 同上，`trigger:'auto'` | `[d.ts]` |
| `/clear` | 对 Claude = 发送 `/clear` 文本 → `conversation_reset` → `session.reset` → 投影器清空 rows（DSH 的 `/clear` 只清视图；Claude 会真正重置上下文——UI 文案区分） | `[d.ts]` |
| 会话树 `/tree` | capability 缺席（Claude 无血缘头；`forkSession` 不记录 parent）→ 命令隐藏 | |

**Phase 4b 实测修正与裁定**：
- **P4-1**：SDK 创建的会话（entrypoint `sdk-ts`）在 `listSessions({includeProgrammatic:false})`（CLI 自己 `/resume` 选择器的口径）中**不可见**；`claude -p --resume <id> --model haiku` 能打开并看到之前的 turn（它追加的条目 entrypoint 为 `sdk-cli`）。故 catalog 一律 `includeProgrammatic:true`（代价：其他 headless 会话也列出）；交互式 `claude` 的选择器看不到 dsh-tui 会话，须按 id `claude --resume <id>`（未在交互 TTY 上复核）。
- SDK 0.3.287 的 `customTitle` = 用户 `/rename` **或** CLI 生成的 `aiTitle`（`sdk.mjs` 里 `customTitle||aiTitle`），无法区分 → 有标题记 `auto`，否则首条提问 `prompt`，再否则目录名 `fallback`；`updatedAt = max(lastModified, 本机 last-used)`。
- `getSessionMessages({includeSystemMessages:true})` 的 system 条目**没有 subtype**；压缩边界由随后的 `isCompactSummary` 用户消息识别。压缩后链路 = 边界、摘要、保留尾部、之后的消息（保留尾部排在摘要之后）。读 API 不带 `tool_use_result`：回放的 Read 卡退为纯文本卡（Write/Edit 由入参出 diff）。
- 转录保留我们推送的 `uuid`（普通提问、`isQueuedCommand` 并入的 steer、`/compact` 回显都是）→ live 用户行与回放用户行的 `anchor` 相同，rewind 同一套。
- `replay.ts` 复用 live 翻译器的块级映射，turn 由真实提问切分；空 thinking 以 API 的 `usage.output_tokens_details.thinking_tokens` 回放为与 live 相同的计数行（无计数则不显示）；子代理 `subagent.start` 紧随父 `Agent` 调用、`subagent.end`（状态取子转录尾部）在其结果后——子代理消息不进主转录；父调用被压缩掉的子代理不插入。上下文窗口无法从转录恢复（读 API 无此字段），首个 live `result` 补上；费用照常取续接后首个 `result`。
- 续接后的 live 翻译器从回放的 turn/seq 继续编号（投影器按 (turn,step) 绑定 attempt、按 seq 去重 assistant 消息：重用编号会把 live 事件绑到/去重进历史）。
- 核心 `/resume`：veto → 挂载账本预占 `claude:<id>` → `prepare` 内 `open({kind:'resume'})` **并** `await history()` → 竞态复查 → 同步 adopt 中先绘制历史、再订阅（Claude 的启动积压在订阅后的微任务里送达）。启动时的 `--resume` 同理：plugin 在构造 channel 前读好 `initialHistory`。一个进程一个后端：运行中的 TUI 内跨后端切换不在范围内。
- 挂载账本：Claude 会话以 `claude:<uuid>` 发布（heartbeat 额外发布当前绑定的非 DSH 会话键），两个 dsh-tui 不会同时驱动同一 Claude 会话；同时用普通 `claude --resume` 打开同一会话**无法察觉**（CLI 不读这个账本）。
- 基准（`scripts/bench-claude-sessions.ts`，合成 config 树、单个 9 KB 脱敏转录复制）：500 会话 项目列表 冷 264 ms / 热 169 ms，全部项目 冷 291 ms / 热 181 ms → 达标（≤ 300 ms 热），不加 mtime 缓存。
- **Phase 5a（压缩前历史）**：原生 JSONL 里压缩边界是 `system/compact_boundary{parentUuid:null, logicalParentUuid, compactMetadata.preservedMessages{anchorUuid, uuids}}`（旧版 `preservedSegment{headUuid, anchorUuid, tailUuid}`）。`loadOlder` 从 resume 链首的边界起逐段回溯：一段 = 从边界的 `logicalParentUuid` 沿 `parentUuid` 走到下一个 `parentUuid:null`（更早的边界或会话首条），把更早边界保留的条目拼到其摘要之后、去掉更新边界保留的条目（已在新视图里），经同一个 `replayClaudeTranscript` 成事件、在临时投影里成行、以负 id + `restored` 前插；单段过长按 1000 条切片（向前延伸到提问边界），游标只进不退。文件 >64 MiB 拒读。折叠行的恢复同样读此文件（行以 `anchor`=uuid/消息 id 或 `callId` 匹配）；Claude 会话因此重新开启折叠，只折有锚点的行。

### 4.12 Auth（技术 + 条款，分开说）

**技术**（`[P1]`）：SDK 直接复用了本机 `claude login` 的凭证（`init.apiKeySource:'none'`，`accountInfo().apiProvider:'firstParty'`，`subscriptionType:'Claude Team'`），TUI 零参与；`ANTHROPIC_API_KEY` 存在时 `apiKeySource:'ANTHROPIC_API_KEY'`；Bedrock/Vertex/Foundry 走各自 env（`AccountInfo.apiProvider`）。`ApiKeySource` 全集：`'ANTHROPIC_API_KEY'|'apiKeyHelper'|'/login managed key'|'none'`（其余为 legacy）`[d.ts]`。

**条款**（原文，2026-10-01 读取）：

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead. — code.claude.com/docs/en/agent-sdk/overview

> we're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits. — support.claude.com（Current Status as of June 15, 2026）

品牌指引（同页）：允许 "Claude Agent"、"{Name} Powered by Claude"；**不允许** "Claude Code"/"Claude Code Agent" 或模仿 Claude Code 的 ASCII/视觉元素；产品应保持自己的品牌。

**设计裁定（D-AUTH，维护者已决定：TUI 内登录是必需的）**：

仓库已有 `dsh-auth`（`@deepseek-harness-tui/dsh-tui/oauth` 行）提供 pi-ai 的订阅 OAuth，`OAUTH_PROVIDER_IDS = ['openai-codex','anthropic','xai']`（`dsh-auth/src/profiles.ts:22`），凭证存 `$DSH_HOME/dsh-auth/credentials.json`，形状 `{type:'oauth', access, refresh, expires}`，刷新在 `CredentialFile.modify` 内串行化（`credentials.ts`）。Claude 后端**复用它**，不另写 OAuth：

1. 凭证来源优先级（`src/backends/claude/auth.ts`）：
   - (a) dsh-auth 的 `anthropic` 凭证 → 子进程 env `CLAUDE_CODE_OAUTH_TOKEN=<access>`（CLI 接受宿主注入的 OAuth bearer：`[d.ts]` `ClaimOptions.env` 明确列出 `CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CODE_SESSION_ACCESS_TOKEN` 为"fresh OAuth/session tokens"；2.1.88 源码 `[hist]` bearer 优先级 `ANTHROPIC_AUTH_TOKEN → CLAUDE_CODE_OAUTH_TOKEN → … → 本机 claude.ai OAuth`）；
   - (b) 用户环境里的 `ANTHROPIC_API_KEY` / Bedrock·Vertex·Foundry env 原样透传；
   - (c) 本机 `claude login` 状态：不注入任何东西，SDK 自行发现（`[P1]` `apiKeySource:'none'` + `apiProvider:'firstParty'`）。
   三者都没有 → `detect()` 返回 `auth:'missing'`，Launchpad/`/login` 引导走 dsh-auth 的 `anthropic` 登录向导（现有 `runOAuthWizard`，`providerWizard.ts:953`）。
   **Phase 3 评审修正（安全，fail-closed）**：(a) 只在**第一方路由**上注入——有效 env = 进程 env 与 `resolveSettings({cwd, settingSources:['user','project','local']}).effective.env` 逐源检查；`ANTHROPIC_BASE_URL` 的 origin 不是 `https://api.anthropic.com`、设了 `ANTHROPIC_UNIX_SOCKET`、任一真值 `CLAUDE_CODE_USE_*` 路由开关（前缀通配，排除 POWERSHELL_TOOL/NATIVE_FILE_SEARCH/COWORK_PLUGINS 等功能开关）、网关路由（`CLAUDE_CODE_USE_GATEWAY`、`CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR`、设置 `forceLoginMethod:'gateway'`/`forceLoginGatewayUrl`）、设置 `apiKeyHelper`、或 `resolveSettings()` 失败 → 一律不读令牌、env 原样透传，`/login` 显示当前路由（只给 origin host）。否则 CLI 会把 claude.ai 令牌以 `Authorization: Bearer` 发给第三方主机（DeepSeek 官方 Claude Code 配置正是 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`）。重连续期为 compare-and-swap：只刷新 CLI 刚拒绝、且 dsh-auth 仍持有的那个令牌；`/login` 用存储值不强刷。
   **Phase 4a 评审修正（安全，fail-closed）**：路由判定再读第三个来源——全局配置 `~/.claude.json`（或 `$CLAUDE_CONFIG_DIR/.claude.json`）的 `env`（CLI 先于设置层把它应用到进程 env）；文件存在却读不了/解析不了按 `settings-unreadable` 处理。变量名一律大小写不敏感匹配（Windows env 语义：`anthropic_base_url` 即 `ANTHROPIC_BASE_URL`），判定与清洗都覆盖每一种写法（误匹配只会 fail-closed）。有效设置含托管 `policyHelper`（解析器看不到它注入的 env）→ 视为不可读；`CLAUDE_CODE_API_BASE_URL`（Files API 也带 OAuth bearer）与 `ANTHROPIC_BASE_URL` 同样做 origin 检查。认证失败的重连先停旧 CLI 再等续期（其队列不会在续期期间被启动并失败；未启动的输入全部按序重推）；`/login` 的延后重连期间提交照常走旧 CLI，最多等 120 s，超时即带"会中断当前回合"的提示强制重连；resume 握手期间 dispose 不再派生"No conversation found"回落进程。
   **Phase 4b 评审修正（安全，纵深防御）**：CLI 自己挑全局配置文件——`<config>/.config.json` 存在即优先于 `.claude.json`，设了 `CLAUDE_CODE_CUSTOM_OAUTH_URL` 则读 `.claude-custom-oauth.json`。闸门改为读**全部**候选（`<CLAUDE_CONFIG_DIR 或 ~/.claude>/.config.json`、`<CLAUDE_CONFIG_DIR 或 ~>/.claude.json`、`.claude-custom-oauth.json`），任一非第一方或任一存在却不可读即 fail-closed；`CLAUDE_CONFIG_DIR` 按 CLI 的读法取（POSIX 精确大小写，Windows 不敏感），不同写法取值不一致即 fail-closed；任一来源设了 `CLAUDE_CODE_CUSTOM_OAUTH_URL` 即不注入（路由 `custom-oauth`）。**钉住**：每次注入 dsh-auth 令牌都经 SDK `settings` 选项（flag-settings 层，用户可控的最高层）设 `ANTHROPIC_BASE_URL=https://api.anthropic.com`，并把 `CLAUDE_CODE_API_BASE_URL`、`ANTHROPIC_UNIX_SOCKET`、`CLAUDE_CODE_CUSTOM_OAUTH_URL`、网关描述符与全部路由型 `CLAUDE_CODE_USE_*` 置空，同时从子进程 env 删除——闸门漏掉的任何非托管（policy 层以外的）来源也只能把令牌送到 Anthropic。托管（policy）层高于 flag 层，且 SDK 的 `managedSettings` 不能携带 `env`，钉住覆盖不到它：闸门在打开会话时读磁盘上的 policy 层并对非第一方路由 fail-closed；残余风险是会话运行期间托管设置改了路由（CLI 在回合之间重载 policy），闸门要到下一次派生才重新判定（Phase 5a 评审修正）。离线探针 `scripts/probes/claude-auth-pin-probe.mjs`（临时 HOME/`CLAUDE_CONFIG_DIR`，哨兵令牌，本地 HTTP 监听器，CLI 2.1.287）实测：`.config.json` 或 `.claude.json` 的 `env.ANTHROPIC_BASE_URL` 指向监听器时，**不钉住**监听器收到 4 个带哨兵的请求（泄漏路径真实存在），**钉住**后监听器 0 个请求、CLI 打到 api.anthropic.com 得 401 `Invalid bearer token`——flag-settings 的 env 覆盖全局配置 env，钉住成立。
   **Phase 3 实施偏差/实测**：云厂商路由（`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`）先于 (a)——CLI 在云路由下忽略 Anthropic 凭证，注入令牌只会让 `/login` 报错来源；启动时 dsh-auth 刷新失败不阻断，回落 (b)/(c) 并给 notice。无效 OAuth 令牌的实测失败形态是 `assistant.error:'authentication_failed'` + `result{subtype:'success', is_error:true, terminal_reason:'api_error', result:'Failed to authenticate. API Error: 401 …'}`（不含 "Please run /login"）；仅一个失败 turn 的会话可用 `resume` 续上。
2. 令牌生命周期：spawn 前经 dsh-auth 读取（它会在过期前刷新）；会话中收到 `assistant.error:'authentication_failed'` 或 `result{is_error, result:/Please run \/login/}` → 刷新一次 → `close()` 当前 query → `query({resume: sessionId})` 带新 env 透明重连（只重试一次，失败则 notice + 引导 `/login`）。评审修正：CLI 尚未持久化任何内容（无 `started` 输入、无 `result`）的会话改用 `sessionId: <同 id>` 重建而非 `resume`（否则握手报 "No conversation found"），遇该错误也回落重建；`/login` 触发的重连等回合与其后排队输入跑完再进行；续期期间旧 CLI 迟到的认证失败忽略；旧 CLI 未开始的输入按序重推，无法重推则 `pending.changed` 撤回 + notice；刷新失败的提示只含 HTTP 状态码。`prewarm()` 若启用，令牌只能在 `claim()` 时注入（`[d.ts]`）。
3. 状态展示：`accountInfo()`（organization/subscriptionType/apiProvider）与 `init.apiKeySource` → `/doctor`、`/login` 状态行；`rate_limit_event` → 订阅用量。
4. 条款与品牌（记录为已知风险，由维护者承担）：官方文档的"第三方不得提供 claude.ai 登录"条款见上；建议后端显示名用 "Claude Agent"、不复刻 Claude Code 视觉元素（品牌指引允许 "{Name} Powered by Claude"）。
5. 施工前探针 P-AUTH-1（§8.8）：用 dsh-auth 的 `anthropic` access token 作为 `CLAUDE_CODE_OAUTH_TOKEN` 跑 probe.mjs，确认 `init.apiKeySource`/`accountInfo()` 与一次完整 turn 成功；并测试令牌过期时的错误形态以实现第 2 点。

### 4.13 错误、取消、关闭、泄漏

- 错误分类：`assistant.error`（`SDKAssistantMessageError`：`authentication_failed|billing_error|rate_limit|overloaded|invalid_request|model_not_found|server_error|max_output_tokens|…`）→ `notice{level:'error'}` + turn.end error；`system/api_retry` → `notice{level:'notice', key:'api-retry'}`（同 key 覆盖）；`result.startup_failure_reason` → 启动失败对话框（`cli_version_too_old`、`cwd_unavailable`…给出修复建议）；进程退出（stream 结束/错误文本含 `ProcessTransport`/`process exited` `[acp]`）→ 会话标 `disposed` + notice "Claude 进程已退出，/resume 可恢复"。
- 未登录/凭证失效：headless 下没有登录 UI，表现为 `assistant.error:'authentication_failed'` 与 `result{subtype:'success', is_error:true, result:'Not logged in · Please run /login'…}`（2.1.88 源码 `[hist]`；`[acp]` 以文本前缀 `Please run /login` 识别）→ 按 §4.12 第 2 点先尝试 dsh-auth 刷新 + 透明重连；仍失败则 notice "Claude 凭证无效或缺失" 并引导 `/login`（dsh-auth `anthropic` 向导）或 `ANTHROPIC_API_KEY`。
- 取消：`cancel('user')` → `q.interrupt()`（回执 `still_queued`）；取消期间 `cancelPending=true` 直到 `result`/`idle`/30s 强制；重复 Ctrl+C 在 `cancelPending` 窗口内按现有 Chat 逻辑强制退出。
- 关闭：`dispose()` = resolve 所有 pending permission（deny）→ `inbox.close()`（stdin EOF，CLI 优雅退出）→ `q.close()` → `abortController.abort()`；全部在 `ctx.effect` 的单一退出漏斗里；`finishExit` 不等待子进程落盘（CLI 自己负责转录写入）。
- 泄漏测试矩阵见 §8.4：start/exit ×100 无残留进程（`ps` 断言）、流中取消、审批中取消、进程崩溃（`kill -9` 子进程）、resume、切会话、带后台任务关闭、Ctrl+C。
- stdout 纯净：SDK 子进程 stdout 是协议管道，不会到终端；stderr 经回调；CLI 自己 spawn 的 MCP 子进程 stderr 跟随 CLI（不继承 TUI 终端）。现有 `installChildStderrGuard` 仍对 TUI 进程内 spawn 生效。

### 4.14 平台差异

- Windows：可执行文件 `claude.exe`（SDK 平台包 `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` `[README]`），PATH 探测用 `where claude`；`spawn` 的 `signal` 在 Windows 是 `TerminateProcess`，SDK 已把它放在 stdin-EOF + 2s 宽限之后 `[d.ts SpawnOptions]`；`pluginDelivery:'argv'` 可能超 32 767 字符（我们不传 plugins）；项目目录名 munging（`C:\Users\x` → `C--Users-x`，由 `listSessions({dir})` 处理，TUI 不自己拼路径——`loadOlder` 的原生 JSONL 读取用 `getSessionInfo` 不提供路径，需沿用 `migrate/adapters/claude-code.ts` 的目录扫描：Phase 5 探针验证 Windows munge 规则）。`startup_failure_reason:'shell_tool_missing'`（无 Git Bash/PowerShell）要有提示。
- macOS/Linux：`bubblewrap` 等 sandbox 依赖只在用户 settings 启用 sandbox 时相关；TUI 不传 `sandbox`。
- 嵌套：dsh-tui 在 Claude Code 终端内运行时必须清洗 env（§4.3）；`[P1]` 已验证清洗后可运行。

---

## 5. 映射矩阵（D）

### 5.1 Claude 消息 → AgentEvent → ChannelState → UI → replay

| Claude 源 | AgentEvent | ChannelState / 投影 | UI | live/persisted/replay | 终态 |
| --- | --- | --- | --- | --- | --- |
| `system/init` | `session.ready`（首次）/ `model.changed`、`mode.changed`、`commands.changed`（后续，仅变化时） | `model`、`mode`、`commandList`、`contextWindow?` | 状态栏、slash 菜单 | live only（每 turn 重发） | — |
| `command_lifecycle{queued}` | `pending.changed` | `pending[]` | PromptInput 队列预览 | live only | — |
| `command_lifecycle{started}` | `turn.start{origin:'user'}` | `working=true, turnStart, spinner requesting` | spinner | live only | — |
| `command_lifecycle{discarded|refused|cancelled}` | `pending.changed` + `notice` | `pending[]` | toast | live only | — |
| 用户消息确认（`command_lifecycle.started`，或 `--replay-user-messages` 下的 `user{isReplay:true, uuid}` 回显） | `user.message{source:'user', id: clientMessageId}`（**不**在 submit 时乐观插入，与 DSH"等日志确认"一致；文本来自 inbox 登记） | `rows: user` | 用户气泡 | live + replay（`getSessionMessages` 的 `user[string]`） | — |
| `user` 含 `<local-command-stdout>` / `[Request interrupted …]` / `isSynthetic` 摘要 | 分别：丢弃 / `interrupt` 行 / `user.message{source:'compaction'}` | — / `rows: interrupt` / `rows: compact` | — | replay 同样过滤（`[acp] stripLocalCommandMetadata`） | — |
| `system/status{requesting}` | （无事件；spinner 由 turn.start 驱动） | | | | |
| `system/status{compacting}` | `compaction.start` | `compaction{phase:'prefill'}` | CompactionStatusRow | live | `compact_boundary` 或 `compact_result` |
| `system/status{permissionMode}` | `mode.changed` | `mode` | 状态栏 | live | — |
| `stream_event message_start` | `assistant.attempt.start` + `step.start` | `openStep`、`lastUsage`（input/cache）| 状态栏 ctx % | live | `message_stop`/`assistant`/`result` |
| `content_block_start:text/thinking/tool_use` | `assistant.delta{kind:'tool-args', partialJson:''}`（tool_use）；其余无 | tool 卡 running（名称已知） | ToolCard | live | `assistant`(tool_use) |
| `text_delta` | `assistant.delta{text}` | `rows: assistant.streaming` | StreamingMarkdown | live | `assistant` 文本块 |
| `thinking_delta`（有正文） | `assistant.delta{reasoning}` | `rows: reasoning.streaming` | AssistantThinkingMessage | live | `assistant` thinking 块 |
| `system/thinking_tokens` / 空 `thinking_delta` | `assistant.delta{reasoning-tokens}` | reasoning 行计数 | 同上（计数态） | live | 同上 |
| `input_json_delta` | `assistant.delta{tool-args}` | tool 卡参数预览 | ToolCard | live | `assistant`(tool_use) |
| `message_delta{usage, stop_reason}` | `assistant.message.usage` 的来源 | `tokens`、`lastUsage`、`mainCost` | 状态栏 | live | — |
| `assistant`（thinking 块） | `assistant.message` 增量块 | settle reasoning 行 | — | live + replay | ✓ |
| `assistant`（text 块） | `assistant.message` 增量块 | settle assistant 行（`canonical`） | — | live + replay | ✓ |
| `assistant`（tool_use 块） | `tool.call` | `rows: tool`，`activeToolCount++` | ToolCard running | live + replay | `tool.result` |
| `assistant.aborted:true` | `assistant.attempt.end{aborted}` | settle 行 | — | live | ✓ |
| `assistant.error` | `notice{error}` | toast + turn error | — | live | ✓ |
| `user`(tool_result) | `tool.result` | 卡片 settle、`contextSegments.tools` | ToolCard ok/error | live + replay（`user[tool_result]`） | ✓ |
| `tool_progress` | `tool.progress` | 卡片 elapsed | ToolCard | live only | — |
| `canUseTool` 回调 | `permission.request` | `PermissionStore` | ApprovalPanel（新选项） | live only | respond/signal |
| `canUseTool(AskUserQuestion)` | `question.request` | `QuestionStore` | AskUserQuestionPanel | live only（结果以 tool_result 记录，replay 复用 `question-record`） | respond |
| `system/permission_denied` | `notice{warning, callId}` | 卡片 error 原因 | ToolCard | live | — |
| `system/task_started`（agent） | `subagent.start` | `subagents[]`、`rows: subagent` | SubagentCard/Dashboard | live + replay（`listSubagents`） | `task_notification` |
| `system/task_progress` | `subagent.progress` | 子代理用量/最近工具 | SubagentCard | live | — |
| `system/task_notification` | `subagent.end` / `task.end` | status、summary | SubagentCard / JobCard / toast | live（replay：转录中的 `<task-notification>` 文本不解析，子代理终态从 `getSubagentMessages` 尾部推断） | ✓ |
| `system/task_started`（bash/workflow） | `task.start` | `backgroundJobs[]`、`rows: job` | JobCard/JobsPanel/状态栏 chip | live | `task.end` |
| `system/background_tasks_changed` | `tasks.snapshot` | 校正 jobs 状态 | | live | — |
| `system/compact_boundary` | `compaction.end` | 上下文计数重置（`post_tokens`） | notice 行 + compact 行 | live + replay（`includeSystemMessages`） | ✓ |
| `conversation_reset` | `session.reset` | 清空 rows/tokens/子代理/任务 | notice | live | ✓ |
| `system/informational{level}` | `notice{level}` | toast（warning+）/ 行（info） | — | live | — |
| `system/notification` | `notice{level by priority, key}` | toast | — | live | — |
| `system/api_retry` | `notice{notice, key:'api-retry'}` | toast（覆盖） | — | live | — |
| `system/model_refusal_fallback` / `no_fallback` | `model.changed{fallback}` + `notice` | `model` | 状态栏 | live | — |
| `system/session_title_changed` | `session.title{auto}` | `sessionTitle` | 状态栏 | live | — |
| `system/commands_changed` | `commands.changed` | `commandList` | slash 菜单 | live | — |
| `system/local_command_output` | `user.message{source:'command-output'}`→ 投影为 `local-output` 行 | rows | — | live | — |
| `rate_limit_event` | `rate-limit` | `rateLimit` | 状态栏 hover | live | — |
| `system/hook_*`、`system/plugin_install`、`system/files_persisted`、`system/elicitation_complete`、`system/memory_recall`、`tool_use_summary`、`prompt_suggestion`、`active_goal`、`system/worker_shutting_down`、`system/mirror_error`、`system/control_request_progress`、`keep_alive` | 忽略或 `notice{info}`（`memory_recall` → `local` 行"已回忆 N 条记忆"） | | | | |
| `result` | `turn.end` | `working=false`、cost、`tpsSamples` | spinner 停止、状态栏 | live（replay 的 turn 边界由 user 消息切分） | ✓ |
| `system/session_state_changed{idle}` | `session.status` + 若 turn 未关：`turn.end{aborted}` 兜底 | | | live | ✓ |

### 5.2 工具卡矩阵

| Claude 工具 | 卡片形态（`ToolPresentation`） | 显示名 key | 颜色 | 备注 |
| --- | --- | --- | --- | --- |
| Read | `read` | `tool-name-read` | accent | 标题 `Read <relpath>:<offset>` |
| Edit / MultiEdit / NotebookEdit / Write | `diff` | `tool-name-edit/write/notebookedit` | mutate | Write 新文件 `oldText:null` |
| Bash / PowerShell | `terminal` | `tool-name-bash/powershell` | exec | `description` 作标题，命令作副标题；`run_in_background` → 同时建 task |
| Glob / Grep | `search` | `tool-name-glob/grep` | accent | |
| WebFetch / WebSearch | `generic` | `tool-name-webfetch/websearch` | accent | |
| Agent / Task | 无卡 → subagent 行 | — | — | |
| AskUserQuestion / ExitPlanMode / EnterPlanMode | 无卡 → 面板 / `notice` | — | — | `EnterPlanMode` → `mode.changed{plan}` |
| TodoWrite / TaskCreate·Update·List·Get | 无卡 → `todo.write` | — | — | GoalTodoPanel |
| Skill | `generic` | `tool-name-skill` | accent | |
| `mcp__*` | `generic` | 原名 | accent | 标题 `server › tool` |
| 其他 / 未知 | `generic` | 原名 | accent | 现有降级路径 |

### 5.3 slash 命令矩阵（Claude 会话下）

| 命令 | 行为 |
| --- | --- |
| `new clear compact resume rename recap rewind fork export btw bg model effort status tokens skills mcp agents context workspace jobs settings` | 走 capability（§4.9–4.11）；`recap`/`btw` 需要无工具单轮 LLM 调用 → Claude 下用 `forkSession` + 一次性 `query({prompt, options:{resume: forkId, maxTurns:1, tools:[]}})` 再 `deleteSession`（Phase 5；之前显示"不可用"） |
| `preset permission plan goal tree trace migrate provider login balance cost config init reload setup` | capability 缺席 → 不出现在菜单；直接输入时 `notify(t('cmd-unavailable-backend',{cmd, backend}))` |
| `doctor plugins` | 后端版本/能力/凭证来源/CLI 路径（新增 Claude 段） |
| `/claude:usage` | `q.usage_EXPERIMENTAL…()`（实验 API，仅本命令使用，失败降级为 notice） |
| Claude 原生 65 命令 | 以 `origin:'backend'` 合并进补全；输入时原样转发为 prompt |
| Shift+Tab | `modes.set` 循环 `default→acceptEdits→plan→default` |

### 5.4 状态栏 / 用量矩阵

| 字段 | DSH 来源（不变） | Claude 来源 |
| --- | --- | --- |
| model | `state.model` | `init.model`/`message_start.model` |
| thinking/effort | `request/header.reasoningEffort` | TUI 选择值（`effort.set` 后）；`init.effort` 若存在 |
| ctx % | `lastUsage.input+cacheRead+cacheWrite / contextWindow` | 同公式；`contextWindow = modelUsage[model].contextWindow` |
| tokens in→out | 累计 `assistant/message.usage` | 累计 `message_delta.usage`（去重：同一 `message.id` 只记一次） |
| cost | CNY 估算（DeepSeek 官方 provider 时） | `costReport{USD, backend}` = `result.total_cost_usd` |
| TPS | 文本 delta 时间窗 | 同（`text_delta` 时间戳） |
| mode | `mode.id` | `permissionMode` |
| 后台任务 chip | jobs 服务 | `tasks.snapshot` |
| 订阅用量（新） | — | `rate-limit.unifiedWindows` |

---

## 6. DSH 迁移方案（E）：不破坏现有体验地迁到新边界

### 6.1 原则

- DSH 的会话事件日志仍是真源；DSH 的 `Agent`/`AgentHandle`/Cordis 事件仍由 `src/dsh-adapter/` 独占。
- 迁移是**纯重构**：把 `projection.ts` 的"解码 DSH 事件"一半抽成翻译器，"变更 ChannelState"一半抽成共享投影器；行为用黄金测试证明逐行一致。
- DSH 专属 specialist（§2.2 B 类）**一个都不改内部实现**，只改接线：它们从 `binding.agent` 读 Agent 的地方改为 `session.capabilities.native.dsh.agent`（同一对象）。

### 6.2 DSH → AgentEvent 翻译表（`src/dsh-adapter/backend/translate.ts`）

| DSH 源（`SessionEvent`/bus） | AgentEvent | 保留的细节 |
| --- | --- | --- |
| `turn/start{turn}` | `turn.start{turn, origin:'user'}` | — |
| `turn/end{turn, reason}` | `turn.end{turn, reason}` | `reason.kind` 一一对应（completed/aborted/interrupted/error） |
| `step/start`/`step/end` | `step.start`/`step.end` | — |
| `user/message{source.kind:'user'}` | `user.message{source:'user', text: firstText, blocks, images, seq, anchor:String(seq), id: data.id}` | IDE 选区附件由投影器从 blocks 重建（现有逻辑） |
| `user/message{source.kind:'goal'}` | `goal.change`（round>0 → roundsStarted） | 不渲染气泡 |
| `user/message` 压缩检查点（`isCompactionCheckpointSource`） | `user.message{source:'compaction', text: summary}` | 投影器：`compact-done` 行 + 上下文计数重置 |
| `user/message` 其他注入 | `user.message{source:'injected'}` | 投影器不渲染、不计 prompt tokens（现状） |
| `agent/assistant-stream` `start`/`chunk`/`end` 帧 | `assistant.attempt.start{attemptId, turn, step}` / `assistant.delta`（`text-delta`→text，`reasoning-delta`→reasoning，`tool-call-delta`→tool-args）/ `assistant.attempt.end{committed|abandoned}` | `revision` 去重在翻译器；`time` 保留给 TPS |
| 旧版 `assistant/chunk`（seq） | 同上 deltas，带 `seq` 与 `legacy:true` | 投影器保留前缀重叠合并（`appendTextDelta(legacy)`） |
| `assistant/message{message, stream, usage, interrupted}` | `assistant.message{seq, anchor, turn, step, attemptId, blocks(text/reasoning/image), usage{input,output,cacheRead,cacheWrite}, canonical: Array.isArray(stream), interrupted}` | `handledAssistantMessages` 幂等由投影器按 `seq` 保留 |
| `assistant/attempt` | `assistant.attempt.end{abandoned}`（turn/step 定位） | `discardAttempt` 逻辑保留 |
| `tool/call` | `tool.call{callId, name, argsJson, presentation}` | `presentation` 由翻译器用 dsh-tools registry `presentCall` 生成；`ask_user_question` → `presentation.card:'question'`；子代理工具名 → `presentation.card:'subagent'`（投影器据此不建卡） |
| `tool/result` | `tool.result{callId, content, isError, errorText, meta, presentation(presentResult), structured}` | `job_output`/`started background job` 解析留在翻译器，额外发 `task.output`/`task.start` |
| `request/context` | `context.capacity{contextWindow}` | |
| `request/header` | `request.header{model, effort}` | 用量归属真源（AC-A4）保留 |
| `system/message` | `system.prompt{text}` | |
| `session/title`、`session/color` | `session.title`、`session.color` | |
| `goal/change`、`todo/write`、`agent-preset/selected` | `goal.change`、`todo.write`、`preset.selected` | |
| `compaction/start|end` + `llm/stream(purpose:'compaction')` | `compaction.start{trigger:'auto'}`/`compaction.progress`/`compaction.end` | 手动压缩的 `cancellable:true` 行由 `channel/compaction.ts` 继续管理 |
| 未知插件事件 | `custom{nativeType, data}` | 投影器交给 `tuiRenderers` |
| bus `agent/status`、`agent/disposed` | `session.status` | `reconcileRetiredProjection` 逻辑保留 |
| bus `agent/inbox/claimed|discarded` | `pending.changed` | |
| bus `subagent/start|end` + 子 `session/event`/流帧 | `subagent.start|progress|end` + 子通道 `assistant.delta/tool.call/tool.result{agentId}` | `subagent-projection.ts` 的 parked reducer 机制改写为：每个 parked 会话一个翻译器实例（状态随会话） |
| `jobs` 服务回调 | `task.start|update|end|output` | |

### 6.3 不动清单（Phase 1–5 一律不改）

`binding.ts` 事务语义（prepare/adopt/switchTo/abandon）、`sessionMounts` 跨进程账本、presets/preset-resolution、permission presets/mode 原子、goal/todo 工具、`sessionTree.ts`、`migrate/*`、`trajectory/*`、`plugin-host`/grants/ledger/decision events、`ide-channel`、`approvals.ts` 的 `external` 来源徽章判定（留在 DSH 权限适配器内）、`ink/`、`native-ts/`、主题与 design-system、`compat/*`。

### 6.4 等价性证明

1. Phase 0 用**当前**投影器对 `scripts/fixtures/dsh/*.jsonl`（录制的真实会话日志：含流式帧、压缩、rewind seed、子代理、jobs、goal/todo、旧版 `assistant/chunk`）生成黄金 `*.rows.json`（`ChatRow[]` + 关键状态字段）。
2. Phase 1 的 `scripts/verify-projection-golden.ts` 用"DSH 翻译器 + 共享投影器"重跑同一 fixture，深比较（忽略 `startedAt/durationMs` 等时钟字段，用注入时钟固定）。
3. 现有 CI 组 `channel-ui`（58 项）、`session-workspace`、`input-terminal`、`render-scroll` 与 CI3 全部不改断言地通过。
4. **已登记的有意偏差**（Phase 2 评审确认）：运行中即被窗口上限折叠（`folded`）的工具卡收到结果时，只更新状态与预览 `resultText`，**不**再挂回 `resultFull`/`resultView`（拆分前会挂回，等于撤销折叠的内存上限）；由 `verify-dsh-translate` 的定点断言固定。

---

## 7. ACP 回退方案（F，本轮只设计）

- 位置：`src/backends/acp/`（唯一允许 import `@agentclientprotocol/sdk` 的目录）。`AcpBackend.open()` 启动目标 agent 进程（`command/args` 来自 `~/.dsh-tui/backends/acp/agents.json`），走 ACP `initialize → session/new|load → session/prompt`。
- 翻译器 `translate.ts`：`session/update` 的 `agent_message_chunk→assistant.delta(text)`、`agent_thought_chunk→assistant.delta(reasoning)`、`tool_call→tool.call{presentation: kind→card}`、`tool_call_update→tool.result/tool.progress`、`plan→todo.write`、`usage_update→context.usage/costReport`、`current_mode_update→mode.changed`、`available_commands_update→commands.changed`、`session/request_permission→permission.request{options: 来自 ACP options}`；`PromptResponse.stopReason→turn.end`。
- 能力：由 `initialize` 的 `agentCapabilities` 与 `session/new` 的 `modes/configOptions` 推导；没有的能力就缺席（UI 显式提示）。`_meta` 扩展（AIR 等）作为 `native.acp.meta` 暴露，**不**进入共享模型。
- Gate（Phase 6）：用 `claude-agent-acp` 作为 oracle 跑一条 smoke（同一 Claude 会话经 ACP 与经原生后端得到的 `ChatRow` kind 序列一致，内容允许差异），证明"再接一个 ACP agent 不需要动 UI"。

---

## 8. 实施阶段与 Gate（G）

### 8.0 全局门禁（Phase 0 建立，之后每个 Phase 必过）

新 `scripts/verify-adapter-boundary.ts` 规则表（替换现有单规则实现，注释与实现一致）：

| 规则 | 允许范围 |
| --- | --- |
| `@deepseek-ai/*` | 仅 `src/dsh-adapter/**` |
| `@anthropic-ai/*` | 仅 `src/backends/claude/**` |
| `@agentclientprotocol/*` | 仅 `src/backends/acp/**` |
| `@dsh-std/*` | 仅 `src/adapter/standard/**`、`src/dsh-adapter/**`（现状） |
| `src/agent/**`、`src/channel/**` | 不得 import 任何上述包，也不得 import `src/dsh-adapter/**`、`src/backends/**`（允许 `src/adapter/ports/*` 类型、`src/i18n`、`src/utils/*`） |
| `src/screens/**`、`src/components/**`、`src/hooks/**`、`src/ink/**` | 不得 import `src/backends/**`；不得 import `src/dsh-adapter/**` 的**值**（类型允许；现有值 import 在 Phase 2 清理，见 §8.7） |
| `native.dsh` / `native.claude` / `native.acp` 属性访问 | 仅 `src/dsh-adapter/**` / `src/backends/claude/**` / `src/backends/acp/**` |

另加 `verify:claude-contract`（SDK pin 一致、`Options` 穷举类型编译）与 `verify:agent-domain`（事件联合类型的穷举 switch 存在于共享投影器与每个翻译器）。CI：登记进 `run-verify-build.mjs`。

### 8.1 Phase 0 — 准备（PR-0，无行为改动）

- 新增：`docs/agent-backend-design.md`（本文）；`scripts/probes/claude-sdk-probe.mjs`、`claude-sdk-probe2.mjs`（本次探针，头部说明"需要本机 `claude` 与 `@anthropic-ai/claude-agent-sdk`，消耗真实用量，不进 CI"）；`scripts/fixtures/dsh/`（录制真实 DSH 日志，脱敏）；`scripts/capture-projection-golden.ts`（用当前投影器生成黄金）。
- 修改：`scripts/verify-adapter-boundary.ts`（§8.0 规则表）；`scripts/verify-adapter-skeleton.ts` 与 `ADAPTER.md`/`AGENTS.md` 的边界描述对齐。
- Gate：现有 CI 全绿；黄金文件提交；`verify:boundary` 新规则对现有代码零违规（若发现 UI 值 import 违规，本阶段只记录、不修）。
- 回滚：revert。

### 8.2 Phase 1 — Agent Domain + DSH 翻译器 + 共享投影器（PR-1，DSH 零行为改动）

- 新增：`src/agent/*`（§3.3–3.4）；`src/channel/projection.ts`（从 `dsh-adapter/channel/projection.ts` 抽取"状态变更"半边，输入改为 `AgentEvent`；保留 TPS、attempt revive、seq 幂等、thinking 折叠、cost 分桶——分桶的"峰谷判定"改为 `deps.pricingWindow?.(time)` 注入，DSH 注入 `isPeakHour`）；`src/channel/{subagents,tasks,emitter,usage,session-reset}.ts`（迁入，去厂商类型）；`src/dsh-adapter/backend/{translate,session,backend,index}.ts`。
- 修改：`src/dsh-adapter/channel.ts`（签名 `createChannel(ctx, session: AgentSession, options)`；`binding.ts` 泛化为持有 `AgentSession`，DSH 会话对象封装 `Agent+AgentHandle`；`binding-events.ts` 收缩为 `session.subscribe → projector.apply` + DSH 专属监听迁入 `DshAgentSession`）；`plugin.ts` 的 `resolveAgent` 返回值包一层 `createDshSession`；`subagent-projection.ts`/`job-projection.ts` 改为消费 `subagent.*`/`task.*` 事件；`transcript.ts` 的 `foldBack/restoreRowFromEvent` 改为通过 `session.history()` 切片重放（DSH 实现仍读日志）。
- 删除：`src/dsh-adapter/channel/projection.ts`（并入翻译器 + 共享投影器）。
- 测试：`scripts/verify-projection-golden.ts`（§6.4）；`scripts/verify-dsh-translate.ts`（fixture → 事件快照，覆盖 §6.2 每一行）；全部现有回归。
- Gate：黄金逐行等价；CI 全绿；手动 TTY 演练（inline/fullscreen/窄终端：启动、流式、工具卡、审批、问卷、compact、rewind、resume、/model、/bg、agent view、退出）。
- 回滚：revert PR-1（Phase 0 的 fixture/黄金保留）。

### 8.3 Phase 2 — Claude 最小可用会话（PR-2）

- 新增：`src/backends/claude/{backend,session,translate,options,process,contract,tools,index}.ts`；`scripts/fixtures/claude/`（由探针脱敏生成：simple-text、partial-text、thinking-tokens-only、tool-success、tool-failure、edit、bash、interrupt、permission-allow、permission-deny、subagent、background-task、compaction、resume-replay）；`scripts/verify-claude-translate.ts`；`scripts/verify-claude-session-lifecycle.ts`（假 Query：start/exit、流中取消、崩溃、dispose 带挂起权限）；`scripts/verify-claude-live.ts`（`DSH_TUI_CLAUDE_LIVE=1` 才跑）。
- 修改：`src/dsh-adapter/index.ts` Config 增 `backend?: 'dsh' | 'claude'`（schema 注释、`cordis.patch.yml`/`cordis.yml` 示例行、README 双语）；`bin/dsh-tui.js` 增 `--backend <id>` → `DSH_TUI_BACKEND`；`plugin.ts`：`resolveSession()`（`backend==='claude'` → `claudeBackend.open`；跳过 preset/route/workspace-attach；审批 answerer 注册移入 `DshAgentSession`）；`channel.ts`：`native.dsh` 缺席时不装 DSH specialist；`ChannelUi` 增 `capabilities`、`sessionRef`、`costReport`；`Chat.tsx`：命令表按 `capabilities` 过滤、不可用命令的提示；`i18n.ts`：`backend-*`、`tool-name-*` 新键。
- Gate：用 dsh-tui 在真实项目完成一个 Claude 编码 turn（流式文本、thinking 计数态、Read/Edit/Bash 卡片、Ctrl+C 取消、错误提示）；DSH 全套回归不变；`verify:boundary` 新目录零违规；进程泄漏检查（start/exit ×20 后无 `claude` 残留进程）。
- 回滚：`backend` 默认 `'dsh'`；Claude 路径为纯新增，revert 不影响 DSH。

### 8.4 Phase 3 — 权限桥 + 原生设置保真 + 控制面（PR-3）

- 新增：`src/channel/permissions.ts`（`PermissionStore`：FIFO、`options`、outcome `allow-once|allow-always|rejected|cancelled`）、`src/channel/questions.ts`（`QuestionStore` 迁入）；`src/backends/claude/permissions.ts`；`scripts/verify-permission-store.ts`；`scripts/verify-claude-permissions.ts`（矩阵：allow / deny / allow-always(updatedPermissions) / 取消请求 / 审批中取消 turn（signal）/ 会话 dispose 时挂起 / 并发多请求 FIFO / AskUserQuestion 作答与取消 / ExitPlanMode approve+reject / 回调抛错）。
- 新增（auth）：`src/backends/claude/auth.ts`（§4.12：dsh-auth `anthropic` 凭证读取/刷新 → env 注入；`authentication_failed` → 刷新 + resume 重连一次）；`/login` 在 Claude 会话下直接进入 dsh-auth 的 `anthropic` 向导；`verify-claude-auth.ts`（假 Query：注入、过期重连、无凭证引导）。
- 修改：`approvals.ts` → DSH 权限适配器（把 `approval/request` 翻成 `permission.request`，outcome 回译 `allowed-once|rejected|cancelled`，`external` 徽章逻辑不动）；`ApprovalPanel.tsx` 按 `request.options` 渲染（DSH 仍两项）；`plugin.ts` 把 QuestionStore/ApprovalStore 的构造交给 channel；Claude capabilities：`models/effort/modes/compact/commands/context/account/mcp`；`StatusLine.tsx`：`costReport` 与 `rateLimit`；`Chat.tsx`：`/model`（Claude 无 provider 段）、`/effort`、Shift+Tab、`/mcp`、`/context`、`/doctor` 段；`options.ts` 的起始 `permissionMode` 走 `resolveSettings`。
- Gate：矩阵全过；DSH 审批/问卷回归（`verify:approval-visibility`、`repro-askpanel`、`verify-askpanel-layout`、`verify:permission-modes`、`verify:plan-exit-restore`、`verify:shift-tab-mode`）不变；手动：Write 审批三选项、always-allow 后同类操作不再询问（CLI 侧持久化）、auto 模式、plan 模式进出。

### 8.5 Phase 4 — 会话生命周期（PR-4）

- 新增：`src/backends/claude/{catalog,replay}.ts`；`~/.dsh-tui/backends/claude/last-used.json`；`scripts/bench-claude-sessions.ts`（合成 0/10/100/500 会话目录，测 `listSessions` 冷/热；Gate：500 会话 ≤ 300ms，否则实现 mtime 索引缓存）；`scripts/verify-claude-replay.ts`（fixture：`getSessionMessages` 输出 → 事件 → rows；含压缩后链路与子代理插入）。
- 修改：`SessionSupervisor.tsx`/`useSessionSupervisor.ts`：tab `DSH | Claude Agent | …foreign`，行类型 `SessionSummary` 增 `backendId`；`resumeTo(ref)`；`sessionHistory.ts` 的 `--resume` 支持 `claude:<uuid>`；`channel/session-resume.ts` 的编排（veto/settle/预占）保留，create/resume 调 `backend.open`；rewind/fork 走 capability；`StatusLine` 会话短 id 读 `sessionRef.sessionId`。
- Gate：`claude` CLI 创建的会话可在 dsh-tui 打开并继续；dsh-tui 创建的会话可被 `claude --resume <id>` 打开（施工探针 P4-1 验证 SDK 创建的会话在 `claude` 的 `/resume` 选择器里是否可见——`listSessions.includeProgrammatic` 暗示可能被隐藏，若隐藏则在文档写明并提供 `/claude:open-in-cli` 提示）；rewind（conversation/files/both）与 fork 行为正确；基准达标。

### 8.6 Phase 5 — 高级保真（PR-5，可拆多 PR）

子代理面板与 `getSubagentMessages` 回放、后台任务（`tasks.stop`、输出尾部、`tasks.snapshot` 校正）、compaction（手动/自动/失败）、`conversation_reset`、`loadOlder` 压缩前历史（原生 JSONL 只读）、notices/api_retry/rate-limit/model fallback、MCP reconnect/toggle、elicitation、`onUserDialog(refusal_fallback_prompt)`、`/claude:usage`、`recap`/`btw`（fork + 单轮无工具 query）、`/add-dir`、`prewarm()` 评估（alpha，默认关闭，`DSH_TUI_CLAUDE_PREWARM=1` 开）。每项附 fixture 测试；Gate：§9 性能基准（冷/热启动、首 token、1000 行渲染、session list、RSS）记录在 PR 描述，与 DSH 对比无明显劣化。

### 8.7 顺手优化（B 类，随各 Phase 一起做；C 类不做）

| 项 | 做法 | Phase |
| --- | --- | --- |
| 边界门禁注释/实现不一致 | §8.0 | 0 |
| `Chat.tsx:29` 未使用的 `sessionCwdMatches` import（把整个 channel 实现拉进 UI 模块图） | 删除 | 2 |
| UI 对 `dsh-adapter` 的值 import（`TuiDialogStore`/`TuiStatusStore` fallback、`ApprovalStore` fallback 经 `compat/liveSession` 拉进 `dsh-session`） | fallback store 构造移到 `src/channel/`/宿主中立模块；Chat 只接收 props | 3 |
| `agentId === sessionId` 假设（`StatusLine.tsx:450`、`ApprovalPanel.tsx:69`、`Chat.tsx:4254,4501`） | 改读 `sessionRef.sessionId` | 4 |
| `src/modelRoute.ts::recordedModelRoute` 读 DSH `request/header` 字符串（事件名泄漏到 UI 层） | 移入 `src/dsh-adapter/backend/`，UI 读 `session.info.model` | 1 |
| `src/adapter/index.ts` 死 barrel、`assertAdapterCapability` 死函数 | **不动**（C 类） | — |
| `effortPrefs.ts:54` 硬编码 `off/low/medium/high/max` | 以 `capabilities.effort.levels()` 为准，prefs 只存 id | 3 |
| `interrupted-ask-next` 文案含 "DeepSeek" | 改为按后端 label 插值 | 2 |

### 8.8 施工前探针清单（实现 Agent 在对应 Phase 开始前跑，结果写进 PR）

| 编号 | 问题 | 方法 |
| --- | --- | --- |
| P2-1 | `command_lifecycle` 完整状态集与时序（`started` 是否在 `system/init` 之前） | 扩展 probe.mjs 记录全部 lifecycle 消息 |
| P2-2 | 用户 PATH 上的 `claude` 版本 ≠ SDK pin 时的行为（例如 CLI 2.1.29x + SDK 0.3.287）：是否正常、`init.capabilities` 差异 | 用 `pathToClaudeCodeExecutable` 指向不同版本 |
| P3-1 | `system/session_state_changed` 是否需要 env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`（`[acp]` 设置了它；两次探针均未见此消息） | 加 env 重跑 P1 |
| P3-2 | `removePending`：`Query` 运行时对象是否有未声明的 `cancelAsyncMessage`，或 `interrupt` 是否接受 `{cancel_queued:true}` | `Object.getOwnPropertyNames(q)` + 试调用 |
| P3-3 | `priority:'now'` 的确切语义（是否中断当前流、是否打断前台工具） | 流中发送 `now` 消息 |
| P4-1 | SDK 创建的会话（entrypoint `sdk-ts`）在 `claude` 交互式 `/resume` 选择器中是否可见；`claude --resume <id>` 是否可打开 | 创建后用 CLI 验证 |
| P4-2 | Windows：`listSessions({dir})` 对 `C:\` 路径的目录 munge；`claude.exe` 探测；`spawn` 关闭行为 | 在 Windows 机器跑 probe |
| P5-1 | thinking 正文在何种设置下可见（`showThinkingSummaries`、`thinking.display`）；`setMaxThinkingTokens(…, 'summarized')` 是否改变 `thinking_display` | 调整设置重跑 |
| P5-2 | `prewarm()` + `claim()` 的实际启动收益与内存 | 对比 cold `query()` |
| P5-3 | `recap/btw` 的 fork + 单轮方案成本与延迟 | 实测 |
| P-AUTH-1（Phase 3 前） | dsh-auth `anthropic` 的 access token 作为 `CLAUDE_CODE_OAUTH_TOKEN` 是否被 CLI 接受；`init.apiKeySource`/`accountInfo()` 读数；令牌过期时的错误形态 | 读 `$DSH_HOME/dsh-auth/credentials.json` 的 access 跑 probe.mjs（不要把令牌写进 trace） |

---

## 9. 风险清单（H）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| SDK 与 CLI 行为不一致 / 版本漂移（每工作日发版） | 翻译器失配、静默丢消息 | 精确 pin + `init.capabilities` 特性探测 + 编译期 `Options` 穷举 + 未知消息类型只记日志不崩溃（`[d.ts]`："ignore types you do not recognize"）+ `/doctor` 漂移警告 |
| 第三方登录条款（§4.12） | 合规（维护者已决定提供登录） | 复用 dsh-auth 既有 OAuth，不新写登录；令牌只经 env 注入子进程、不落入转录；显示名建议 "Claude Agent" |
| OAuth 令牌过期/被 CLI 拒绝（P-AUTH-1） | 会话中断 | spawn 前刷新；`authentication_failed` → 刷新 + resume 重连一次；探针先验证 pi-ai 令牌被 CLI 接受 |
| 会话索引/转录兼容 | 双真源 | 只用 SDK 读写 API；TUI 不写转录；压缩前历史只读 |
| `getSessionMessages` 只给压缩后链路 | resume 后看不到旧历史 | `loadOlder` 原生 JSONL 只读（Phase 5），UI 显示"已压缩 N 条" |
| partial stream 生命周期（`message_stop` 迟到/缺失、网关不流式） | 行永远 streaming | turn 终态只认 `result`；`assistant` canonical 覆盖；30s 强制收敛 |
| 权限死锁 | UI 卡死 | §4.7 六条规则 + 测试矩阵；signal 驱动清理 |
| 子代理生命周期（异步启动、`task_id`=agentId 不成文） | 卡片丢失/错配 | 以 `parent_tool_use_id` 预建、`task_started` 补全；`tasks.snapshot` 校正；fixture 覆盖 |
| 后台任务跨 turn | spinner 状态错 | `working` 只跟 turn；任务 chip 独立 |
| 进程泄漏 / 内存（每会话 230–260MB） | 机器变慢 | `maxLiveSessions`；dispose 顺序；泄漏测试；parked 会话转 close+resume |
| UI source-of-truth 重复 | 状态漂移 | 用户消息也等后端确认（`command_lifecycle.started`）再入 rows；pending 由后端队列驱动 |
| `env` 整体替换、嵌套 Claude Code 环境变量 | 子进程启动失败/串会话 | §4.3 清洗清单 + 探针 |
| 子进程 stderr 污染终端 | alt-screen 花屏 | `stderr` 回调；永不继承 |
| Windows 差异 | 启动失败 | P4-2；`startup_failure_reason` 提示 |
| 性能回归（投影器重构） | 滚动卡顿/内存 | 黄金测试 + 现有 `verify-scroll`/`verify-resticky`/heap 探针；1000 行基准记录 |

---

## 10. 对 20 个问题的直接回答

1. **`src/adapter/` 与新层的关系**：并列。`src/adapter/` 是宿主/插件平面（legacy 模式下大半休眠），新层是 `src/agent/`（领域）+ `src/channel/`（共享投影）+ `src/backends/*`；只复用其 ports 类型、`createChannelUi`/read-view、effect 矩阵、host-registry。
2. **保留 `src/dsh-adapter/` 名字和范围？** 保留名字；范围收窄为"DSH 宿主集成 + DSH 后端（`backend/`）+ DSH 专属 specialist"；中立代码逐步迁出到 `src/channel/`。
3. **Shared Channel 的最低职责**：§3.5 六条（绑定、回放/订阅→唯一 reducer、视图模型、动作委托到 capability、输入管线、宿主接缝）。
4. **DSH 事件在哪 normalize**：`src/dsh-adapter/backend/translate.ts`（事件）+ `session.ts`（动作）。
5. **Claude 事件在哪 normalize**：`src/backends/claude/translate.ts`（live）+ `replay.ts`（store 读 API）。
6. **是否需要内部 AgentEvent，还是 snapshot/projector**：需要事件（live 流与回放同词汇表；投影器是唯一 reducer；snapshot 只是投影器的输出 `ChannelState`）。
7. **durable truth vs UI projection**：§3.6；`ChannelState` 全部是投影，可从后端真源重建。
8. **Claude 会话真源**：`~/.claude/projects` 转录 + SDK 读写 API；TUI 只存 last-used/pins。
9. **`/resume` 同时列 DSH/Claude**：`SessionSupervisor` 多 tab，行携带 `backendId`，打开走 `backend.open({kind:'resume'})`。
10. **后端专属 feature 不污染 UI**：`capabilities` 类型化对象 + `native.*` 逃生舱只允许在各自后端目录访问（门禁）；UI 只看 `ChannelUi.capabilities` 布尔快照决定显示。
11. **权限死锁**：§4.7 六条 + signal 驱动 + 30s 强制收敛 + 测试矩阵。
12. **子代理进入现有 UI**：`subagent.*` 事件 → 现有 `SubagentActivityStore`/卡片/面板，`task_id` 即 agentId，`parent_tool_use_id` 预建。
13. **后台任务表达**：`task.*` + `tasks.snapshot` → 现有 jobs 面板/chip；`working` 不与任务绑定。
14. **Claude settings/CLAUDE.md 原生语义**：§4.3 Fidelity Profile（preset 系统提示、全部 settingSources、工具 preset、hooks/MCP/plugins 全交 CLI）。
15. **Auth**：§4.12——复用既有 dsh-auth `anthropic` OAuth（`/login` 向导已存在），令牌经 `CLAUDE_CODE_OAUTH_TOKEN` 注入 CLI 子进程；`ANTHROPIC_API_KEY`/云厂商 env 透传；本机 `claude login` 由 SDK 自行发现；过期时刷新 + resume 重连；条款风险已记录。
16. **版本漂移**：§4.2——精确 pin + 能力探测 + 编译期穷举 + 漂移警告不阻断。
17. **ACP 插在哪**：`src/backends/acp/` 翻译到同一 AgentEvent（§7）。
18. **接 Codex 要改哪些共享代码**：理论上只增 `src/backends/codex/`；可能触碰共享层的只有"新事件子类型"（如 Codex 特有的 exec approval 形态）——加到 `AgentEvent`（可增不可删）与投影器一个 case。
19. **顺手优化什么、不动什么**：§8.7 / §6.3。
20. **可回滚、可分 PR、可验证**：§8 六个 Phase 各自独立 PR，每个有 Gate；Phase 1 用黄金等价证明零行为改动；Phase 2+ 的 Claude 路径默认关闭（`backend:'dsh'`）。

---

## 附录 A：如何复跑探针

```sh
mkdir -p /tmp/claude-probe && cd /tmp/claude-probe && npm init -y >/dev/null
npm i --ignore-scripts @anthropic-ai/claude-agent-sdk@0.3.287
cp <repo>/scripts/probes/claude-sdk-probe.mjs probe.mjs      # 施工时迁入仓库
node probe.mjs "$PWD/run"      # 生成 run/trace.jsonl；消耗少量 haiku 用量
```
probe 读取 `/home/coder/.local/bin/claude`（改成本机路径或删掉该行用 SDK 自带二进制）。
两份本次原始 trace（已截断长字段）位于本会话 scratchpad：`scratchpad/sdk/probe-run/trace.jsonl`、`trace2.jsonl`；它们含本机路径与组织名，**不要**直接作为仓库 fixture，用 `scripts/fixtures/claude/redact.mjs`（Phase 2 新增）脱敏后再入库。

## 附录 B：探针观察到的、d.ts 未声明的字段/消息（翻译器按 `unknown` 收窄，缺席即忽略）

`command_lifecycle{command_uuid,state}`；`system/session_title_changed{title}`；`stream_event.thinking_display`；`thinking_delta.estimated_tokens`；`rate_limit_info.unifiedWindows`；`user.tool_result_meta[]`；`user.isReplay/isSynthetic`；`assistant.wire_tool_inputs`；`result.subagent_stats/first_request_input_tokens/ttft_*`；`init.memory_paths/messaging_socket_path/analytics_disabled/per_turn_effort_active`；`initializationResult.pid/current_permission_mode/session_state/capabilities`。

## 附录 C：旧版（2.1.88 泄露源码）线索与验证状态

只列对本设计有影响的条目；`[hist]` = 仅见于旧源码，`✓` = 已被本机 d.ts/探针/官方文档证实，`?` = 施工前须验证（已编入 §8.8）。

| 线索 | 状态 | 对设计的意义 |
| --- | --- | --- |
| 转录目录 `<cfg>/projects/<sanitized cwd>/<id>.jsonl`，子代理 `<id>/subagents/agent-<agentId>.jsonl` + `.meta.json`，无索引文件，列表 = readdir + 头尾 64KB 扫描 | ✓（`[P1]` 目录、`listSubagents`；d.ts 注释） | 用 SDK 读 API，不自建索引；`loadOlder` 按 sessionId 扫描定位文件 |
| 目录名编码：非字母数字→`-`，>200 字符加哈希且 Bun/Node 不一致 | `[hist]` ? | 不自己计算目录名（§4.11） |
| 流式下每个内容块一条 `assistant` 记录，共享 `message.id` | ✓ `[P1]` | 翻译器按 `message.id` 聚合 attempt |
| `result` 在后台 `local_agent`/`local_workflow` 运行期间被 hold back；`session_state_changed:idle` 为权威回合结束信号且受 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 门控 | `[hist]`，`[acp]` 同样设置该 env；`[P1]` 异步子代理场景下 `result` 并未被 hold back | 以 `result` 为主、`idle` 为兜底；设置该 env；P3-1 |
| `priority: now/next/later` 语义（now 中止在途、next 工具轮次后并入、later 回合后） | `[hist]` ? | §4.4 放置映射；P3-3 |
| `interrupt` → 挂起的 `can_use_tool` 收到 `control_cancel_request`，SDK 侧 `AbortError`，工具结果写为拒绝 | ✓ `[P2]` | §4.7 规则 1 |
| 子代理在同进程同 `query()` 循环内运行；流上唯一身份是 `parent_tool_use_id`；`agent_id` 只在 `can_use_tool`/hooks/task 事件上；文本轮默认不转发 | ✓（`[P1]` + d.ts `forwardSubagentText`） | `forwardSubagentText:true`；`task_id` = agentId |
| 任务通知以 `later` 优先级作为普通 user 轮次投递（非 isMeta），自动开启新 turn；输出文件 `/tmp/claude-<uid>/<cwd>/<sid>/tasks/<id>.output` | ✓ `[P1]`（`origin.kind:'task-notification'` 的 turn；output_file 路径） | `turn.start{origin:'notification'}`；`tasks.readOutput` |
| 文件检查点 id = 用户消息 uuid；`rewind_files` 只回滚文件不截断对话；SDK 需 `enableFileCheckpointing` | ✓ `[P1]` dryRun | rewind = `rewindFiles` + `forkSession(upToMessageId)` |
| 自动压缩阈值：`min(window, autocompact 设置) - min(maxOut, 20k) - 13k`；`/compact` 为本地命令；边界 `parentUuid:null` 使 resume 链在此截断 | ✓ `[P2]`（`getSessionMessages` 只返回压缩后链路） | §4.11 压缩前历史 |
| `/model` 持久化到 `~/.claude/settings.json`，SDK `set_model` 仅会话内 | `[hist]` ? | TUI 的 `/model` 选择另存 `~/.dsh-tui`，不写 Claude settings |
| effort 梯度 `low/medium/high/max`（当前 d.ts 另有 `xhigh`），`max` 不写入 settings | ✓ d.ts（`EffortLevel`）/ `[P1]` `supportedEffortLevels` | `effort.levels()` 以 `ModelInfo` 为准 |
| 设置合并：数组拼接去重、对象深合并、标量后者优先；`--setting-sources` 省略时 SDK 旧版默认 `[]` | d.ts 现为"省略 = 全部加载"，`[P2]` 证实 | 仍显式传 `['user','project','local']` |
| 未登录在 headless 下表现为 `authentication_failed` + `result success/is_error` | `[hist]`，`[acp]` 按文本识别 | §4.13 |
| `--verbose` 是 `stream-json` 的前提；SDK 自动加 | ✓（SDK 内部） | 不用关心 |
| `CLAUDE_CODE_ENTRYPOINT=sdk-ts` 会隐藏 `claude-code-guide` 内置 agent；User-Agent 带 `client-app/<CLAUDE_AGENT_SDK_CLIENT_APP>` | `[P1]` init.agents 无 `claude-code-guide` ✓ | 文档里说明差异；设置 `CLAUDE_AGENT_SDK_CLIENT_APP` |
| Windows：无 ConPTY，Bash 走 git-bash；`shell_tool_missing` 启动失败 | d.ts `SDKStartupFailureReason` ✓ | §4.14 |
