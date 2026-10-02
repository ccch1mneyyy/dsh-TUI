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

- **Checkpoint 1（进行中，提交 2 完成后改写本节）**：`src/agent/`（领域类型）、`src/channel/projection.ts`（共享投影器，`apply(events,{replay})`）、`src/dsh-adapter/backend/translate.ts`（DSH 翻译器）落地；`src/dsh-adapter/channel/projection.ts` 退为「翻译器 + 共享投影器」兼容外壳；黄金管线已切到新管线，`verify:projection-golden` 不改黄金通过（5 份、72 行、28 处 live 差异）。
