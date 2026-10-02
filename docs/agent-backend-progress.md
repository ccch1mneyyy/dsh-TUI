# agent-backend 施工日志

> 分支 `feat/agent-backend`（worktree `/home/coder/dsh-tui-agent`，基于 `main` d96dea69）。
> 实施：Opus 5.5 子代理按 `docs/agent-backend-design.md` §8 逐 Phase 施工；监督：Fable 5.1（本会话）。
> 规则：每个 Phase 一个提交；只暂存显式路径；不 push、不开 PR（留给维护者早上审阅）；
> 探针结果与方案不符时以探针为准并在本文记录"实测修正"。

## 协议

1. 实施代理读方案与本文 → 跑本 Phase 探针 → 施工 → 自跑本 Phase Gate → 提交 → 在本文追加条目（≤ 30 行：改了什么、跑了什么、未验证什么、实测修正、下一 Phase 前置）。
2. 评审代理（独立上下文）对照方案审 diff，只报问题。
3. 监督者复跑关键 Gate、决定是否进入下一 Phase；架构/决策分歧由监督者裁定并记录在下方"决策记录"。

## 决策记录

- D-AUTH（维护者）：TUI 内登录必需，复用 dsh-auth `anthropic` OAuth（方案 §4.12）。
- D-BASE（监督者）：基于 `main`（d96dea69）而非 `feat/launchpad-onboarding` 的未提交工作；launchpad/onboarding 改动不进本分支。
- D-GIT（监督者）：本分支只本地提交，不 push；PR 由维护者审后再开。

## Phase 日志

（由各 Phase 的实施代理追加）

### Phase 0 — 探针、边界门禁规则表、投影黄金基线（Opus 5.5，无行为改动）

- **改动**：`scripts/probes/claude-sdk-probe3.mjs`（P2-1/P3-1/P3-3 + P3-2 方法列举；一条会话 5 段、8 个 haiku turn）；`verify-adapter-boundary.ts` 换成 §8.0 规则表 + `scripts/adapter-boundary.allowlist.json`（存量 UI→dsh-adapter 值 import：35 对文件、36 处）；skeleton 注释、`ADAPTER.md`、`AGENTS.md` 边界段对齐；`scripts/fixtures/dsh/`（`generate.ts` + 4 份日志 + 2 份帧 + 5 份 golden）、`scripts/lib/projection-golden.ts`、`capture-projection-golden.ts`、`verify-projection-golden.ts`（`verify:projection-golden`，登记 `channel-ui` 组）；`verify-source-hygiene.mjs` 的 `CLAUDE_CODE_*` 规则对 `src/backends/claude/`、`scripts/probes/`、两份 agent-backend 文档豁免。
- **P2-1**：状态实见 `queued/started/completed/cancelled`。用户 turn：`queued`→`started`(+2–8ms)→本 turn `init`(+13–28ms，冷启动 462ms)→`status requesting`→首个 `stream_event`→`result`→`completed`(+0–5ms)。`started` 先于 `init`。`next` 并入的消息在工具轮次后才 `started`，不重发 `init`、无 `user` 回显，`completed` 早于 `result` ~3ms；`result.user_message_uuids` 列全部并入 uuid。
- **P3-1**：设 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 后有 `session_state_changed`：`running` 早于 `queued`，`idle` 在 `result`/`completed` 之后 0–5ms，背靠背 turn 之间不回 idle；`requires_action` 未触发（工具被 CLI 规则放行，没走 `canUseTool`）。
- **P3-3**：`next`+前台工具 → 工具跑完后并入同一 turn（一个 `result`，`num_turns:3`）；`next`+纯文本流 → 当前 turn 正常完成，消息成为下一 turn。`now`+文本流 → ~10ms 中断（`assistant.aborted:true`），`result{subtype:'success', terminal_reason:'aborted_streaming'}`，原命令 `cancelled`；`now`+前台 Bash → 不杀不转后台，等工具结束（6.6s）后 `aborted_tools`，下一工具不跑。两种中断都**无** `[Request interrupted by user]` 回显。前台 Bash ~3s 后也发 `task_started{is_backgrounded:false}`。
- **P3-2（顺带）**：运行时 `Query` 有未声明的 `cancelAsyncMessage`（未调用）。**P2-2 延后**：本机只有一个 CLI 版本。
- **实测修正已写入方案**：§3.3/§4.4 turn 关闭先判 `terminal_reason`；§4.4 `started` 在已开 turn 内=并入；放置映射 `steer→next` 成立、`now→priority:'now'` 裁定（代价：前台工具期间延迟）；§4.3 env 行；§4.8 前台 `local_bash` 不建任务卡。另：`channel-ui` 组实为 90 项（方案写 58），本 Phase 后 91。
- **Gate**：`pnpm build` ✓（compile + `verify:build` 83/83，新 boundary：625 文件 / 3506 个 specifier、36 处 allowlist 警告）；`pnpm verify:package` ✓（2130 文件、28 个入口目标）；CI 三回归 ✓（repro-askpanel 11 PASS、verify-askpanel-layout ALL PASS、repro-toolcards 34 PASS）；`DSH_TUI_LANG=zh run-ci-group channel-ui` 第一次 90/91（`verify-compaction-progress` scene1 渲染唤醒次数断言；在未改动的 HEAD 树上单跑 6 次失败 2 次，属既有 flake），重跑 91/91 ✓；`verify:projection-golden` ✓（5 份 golden、72 行 replay、28 处登记的 live 差异）；门禁反例自测（新目录越界、UI 值 import、`native.*`、过期 allowlist、篡改 golden、未登记 live 差异）均按预期失败。没有 `test`/`lint` 脚本可跑。
- **决策**：D0-1 UI 值 import 规则按（UI 文件, dsh-adapter 目标）登记，未登记即失败、过期条目也失败（只减不增），通过时一行警告（`--verbose` 列明细）；类型判定 = `import type`/全部内联 `type`/`.d.ts`/类型位置的 `import()`。D0-2 门禁顺带落实 §3.1 的 `agent ↛ channel`。D0-3 golden = replay 全快照 + live 差异（`liveRows`/`liveState`/`liveDiff` 逐条理由，未登记理由拒绝写入）+ `liveTimeline`（逐输入瞬态视图）；初始 state 用 `createInitialChannelView`（`agentPreset:'ptc'` 覆盖改名分支），renderer stub 覆盖 tuiRenderers 接缝，`v3-turns` 另跑 `thinkingFold:'full'`。D0-4 不做真实日志脱敏 fixture：本机日志为 zstd v4，工具参数 JSON/路径无法靠等长占位安全脱敏，合成 fixture 已覆盖 §6.2 各族。D0-5 探针 CLI 路径经 env `CLAUDE_CODE_EXECUTABLE` 传入，仓库不写本机路径。D0-6 hygiene 豁免：89264a82 的方案文档与两份探针本就让 `verify:source-hygiene` 失败，Claude 后端也必须设置/清洗这些变量；其余文件规则不变（已用反例验证）。
- **延后**：P2-2；`requires_action` 与 `cancelAsyncMessage` 语义（Phase 3 权限探针）；`interrupt()` 对前台工具的效果（若 Phase 2 演练嫌 `now` 延迟）；传递 import（经中间模块碰厂商包）门禁仍不查。
- **Phase 1 前置**：保持 `verify:projection-golden` 不改黄金文件通过（`liveDiff` 不得新增条目）；`assistant/chunk` 旧日志的 live/replay 差异是现状，翻译器须原样保留；翻译器状态（attempt/revision/seq 幂等、legacy 前缀合并）以 golden 的 `liveTimeline` 为准；新目录 `src/agent/`、`src/channel/` 已受门禁约束。

## Phase 1

### Phase 1 — Agent Domain、共享投影器、DSH 翻译器与 AgentSession 接线（Opus 5.5，DSH 零行为改动）

- **提交**：checkpoint 1 `47c9269c`（领域 + 共享投影器 + 翻译器 + 黄金管线切换）；checkpoint 2 = 本提交（`47c9269c` 的直接后继；channel 持有 `AgentSession`）。
- **挪动**：`src/agent/{events,session,capabilities,backend,refs,presentation,index}.ts`；`src/channel/projection.ts`（`createChannelProjection(state,deps)`，`apply(events,{replay,wake})`/`reset`/`settleStreaming`/`updateSpinnerMode`，原 reducer 逐行移植，`never` 穷举）；纯辅助迁入 `src/channel/{sanitize,question-record,transcript,usage,selection-record}.ts`，旧路径 re-export；`src/dsh-adapter/backend/translate.ts`（§6.2）与 `session.ts`（`createDshSession`；`DshNative` 经模块增强挂 agent/handle/ctx/subscribeRaw/rawHistory/translateReplay/resetTranslation/presenters）；`dsh-adapter/channel/projection.ts` 只剩兼容外壳（供直驱脚本）；`binding.ts` 持 `AgentSession`（prepare/adopt/switchTo/abandon/waitForDisposal/generation 不变，`agent`/`handle` 为 native.dsh 视图，生命周期仍按 handle 判定）；`binding-events.ts` = `native.subscribeRaw`（messageObserver/mode）+ `session.subscribe → projector.apply`；`input-delivery` 止于 `session.submit`，`input-actions` 的 cancel/removePending/interrupt 走 session；9 处交给 binding 的 agent/handle 在交接点 `createDshSession`；`plugin.ts` 包装 `resolveAgent` 结果。
- **D1-1** attempt 绑定（active attempt、openStep 收养重连帧）与 `seq` 幂等留在投影器；翻译器只持帧 revision 栅栏和未结调用（presenter/图片/任务喂入的输入）。理由：`/clear` 只重置投影器，语义与拆分前一致；channel 的 `resetProjection` 仍连带重置绑定会话的翻译器。
- **D1-2** 峰谷判定注入 `deps.pricingWindow`（DSH 注入 `dshPricingWindow` = `isPeakHour`，缺省全进 idle）；桶算术在 `src/channel/usage.ts` 中立实现，`src/channel` 不 import `deepseekPricing.ts`。
- **D1-3** `job_output`/后台启动 ack 由翻译器派生 `task.output`/`task.start`（带 callId），投影器仅当该 result 刚结算了一张卡时才喂 `deps.jobs`（复刻「有卡才喂」）。
- **D1-4** `AgentEventMeta.wake`（sync/frame/none）由后端给出；binding-events 据此 `emit`/`emitStream`，被栅栏丢弃的帧（空批次）保持原唤醒节奏。会话对 `session/event` 只装一个监听，raw 订阅者（mode/messageObserver）先于翻译批次，与拆分前单监听的顺序和数量一致；退订后的监听惰性（ABA 安全）。
- **D1-5** `clientMessageId` = DSH 消息 id：DSH 输入管线仍 `createUserMessage`，经 `AgentInput.native` 交给 `submit`（`createUserMessage` 不收 id，`freezeMessage` 不在 peer 下限）。
- **D1-6** `ToolPresentation` = `ToolCallView`/`ToolResultView` + `card:'question'|'subagent'` 抑制标记；preset 改名折叠变为事件 `aliases`；`max-tokens`/`forked` 走 `TurnEndReason{kind:'other',label}`；`tool.result` 增 `text`/`images`，`pending.changed` 增 `claimed`/`discarded`，`CancelCause` 增 `interrupt`，`goal.change` 增 `roundsStarted`/`round`。
- **方案偏差**：① `replaySessionSeed` 用 `native.dsh.translateReplay(seed)` 同步翻译，不 `await session.history()`——adoption 尾部是同步事务、`createChannel` 同步返回（`src/dsh-adapter/channel.ts` replaySessionSeed）。② `agent/pre-step` 附件登记仍在 `input-delivery.ts`（channel 构造时注册，保 waterfall 顺序 D3/D4），session 只做 followup/steer。③ subagent 的 owner 级监听（跨绑定、含子会话）未改走 `subscribeRaw`，仅以 native.dsh 存在为挂载条件（`binding-events.ts` installSubagents）。④ `AgentSession.removePending` 返回 `boolean | Promise<boolean>`（Alt+Up 合同同步）。⑤ `createChannel` 仍接受裸 `Agent` 并自动包装（48 个脚本/嵌入方）。⑥ 模型选择 waterfall 留在 binding-events 的 DSH 分支。⑦ `dshBackend.open()` 未做（plugin 仍 `resolveAgent`）。
- **未证明等价的边角**：运行中即被 MAX_ROWS 折叠的卡片收到 result 时，旧代码以空参数求 presenter/job id，新代码用翻译器保存的原参数；`/clear` 后重投的旧帧不再被 -1 栅栏放行；tools 注册表改为每会话首次 presenter 调用时解析（旧：channel 构造时一次）。
- **Gate**（checkpoint 2 树上全量）：`pnpm build` ✓（verify:build 83/83；boundary 640 文件 / 3568 specifier）；`verify:package` ✓（2175 文件、28 入口）；CI 三回归 ✓（repro-askpanel 11、askpanel-layout ALL PASS、repro-toolcards 34）；`DSH_TUI_LANG=zh run-ci-group` channel-ui 92/92、session-workspace 46/46、input-terminal 28/28；`verify:projection-golden` ✓（5 份、72 行、28 处登记 live 差异，`scripts/fixtures` 零改动）；`verify:dsh-translate` 49/49；聚焦 compact / thinking-preview / channel-goal-todo / goal-todo / submit / queue / rewind-edit / compact-switch / streaming-markdown-spacing / channel-ui / binding-transaction / channel-composition / adapter-channel / channel-trace-read / session-reset / model-lifecycle-fences / live-session / background-extraction / activity-store / session-browser 全过；`pnpm smoke` ✓。checkpoint 1 树：build 83/83、channel-ui 91/91、同批聚焦脚本全过。未做手动 TTY 演练（本环境无交互终端与凭证）。
- **脚本改动（只改调用形状，断言不变）**：`verify-binding-transaction`、`verify-channel-router-lifecycle`、`verify-channel-ui`、`verify-background-extraction`、`repro-effort`、`verify-session-v3`（binding 现收 `AgentSession`）；结构正则：`verify-channel-composition`（`const session = capture.session`、`session.subscribe(`、`projector.apply(`）、`verify-settings-namespace` 与 `verify-activity-ownership`（plugin.ts 现为 `createChannel(ctx, createDshSession(ctx, { agent, handle }), {`）。新增 `verify:dsh-translate`（§8.2，49 项 §6.2 覆盖断言，登记 `channel-ui` 组）。
- **Phase 1b**：subagent-projection / job-projection / pending 改为消费 `subagent.*`/`task.*`/`pending.changed`（会话产出，去掉 owner 级 ctx 监听）；`foldBack`/`restoreRowFromEvent` 改走翻译后历史；`verify:agent-domain` 门禁；`recordedModelRoute` 移入 backend（§8.7）；文档/AGENTS.md 的「投影属于 channel.ts」措辞。
- **Phase 2 前置**：adoption 事务前预取 `history()`；异步 `removePending` 的 UX；`native.dsh` 缺席时不装 DSH specialist（现 `dshNative()` 直接抛错）；Claude 翻译器须先发 `assistant.attempt.start` 再发带 attemptId 的 delta、为 `tool.result` 填 `text`/`errorText`；`reasoning-tokens` 的投影态待定。
