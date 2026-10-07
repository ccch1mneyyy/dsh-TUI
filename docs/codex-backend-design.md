# Codex 原生后端：技术方案与实施手册

[文档索引](README.md) · [多后端架构](agent-backend-design.md) · [Claude 后端用户说明](claude-backend.md)

本文是 dsh-TUI 接入 OpenAI Codex（`codex` CLI）的**完整技术方案与实施手册**。它的目标读者是
负责落地的实现者（人或 AI）：读完本文、[多后端架构](agent-backend-design.md)、`AGENTS.md`
与 `docs/contributing.md`，不需要其他上下文就能按 §11 的分期逐步实现。

> **实施状态**：C0–C4 与中立层 N1–N9 的功能实现已完成，真实凭据回合与交互终端仍需有条件实测。当前进度、实测结论与偏离记录见
> [施工日志](codex-backend-progress.md)，接手步骤见[交接文档](codex-backend-handoff.md)。
> 三者的权威顺序：施工日志（实测）＞ 本文（设计）＞ 交接文档（操作指引）。
> 标注 **C0 已验证** 的段落已按实测就地修订；**C1 实施修订**/**评审修订**标注实现阶段确认的规则。

- 验证基线：`codex-cli 0.160.1`（2026-10-06 npm `latest`），协议源码 tag `rust-v0.160.1`；
  最低支持 `0.144.0`（V16）。
- 调研材料：原始调研机器上的生成类型、源码检出、探针与录制原件**不随仓库**；实现所需部分已入库
  （`src/backends/codex/protocol/generated/`、`scripts/fixtures/codex/`、`scripts/probes/codex-*.mjs`）。
  需要对照 Codex 源码时按交接文档 §3 检出 `rust-v0.160.1`。

---

## 0. 一页结论

1. **传输：`codex app-server` 的 JSON-RPC v2（stdio）。** 官方 TS SDK `@openai/codex-sdk`
   只是 `codex exec --experimental-json` 的包装（一回合一进程、无审批、无 steer），做不到原生；
   app-server 才是 Codex 自己的 TUI（进程内嵌 app-server）、VS Code 插件、桌面版和官方 Python
   SDK 共用的接口。我们与官方前端处于同一层：同一套 thread/turn/item 模型、同一份
   `~/.codex`、会话互通。
2. **一个 TUI 进程一个 app-server 子进程，多 thread 复用一条连接**（`CodexHub`）。`/new`、
   `/resume`、会话浏览器、子代理转录都不再付启动开销（实测启动+握手 ≈470 ms，之后单请求
   2–50 ms）。
3. **运行时零 npm 依赖。** 只调用用户安装的 `codex` 二进制；协议类型由
   `codex app-server generate-ts --experimental` 生成后**入库**（纯类型，编译期提示），运行时
   一律 `unknown` 收窄。版本漂移由 `verify:codex-contract` 门禁与运行时 drift 提示兜住。
4. **新代码集中在 `src/backends/codex/`，channel 不写代码；**界面全部复用现有组件。中立层
   只做 9 处小扩展（§6 N1–N9），其中 3 处直接决定显示体验：运行中工具的实时输出、带真实行号的
   unified patch diff、问卷的保密输入；另有一个通用的事件流不变量检查器（§10.3）守住所有后端。
5. **登录**：内置 OAuth 的 `openai-codex`（ChatGPT 订阅）以 `chatgptAuthTokens` 外部托管模式
   交给 app-server（只在内存，不写 `auth.json`），刷新由 app-server 反向请求、我们按
   compare-and-swap 应答；**只在第一方 OpenAI 路由上注入**。中转站/API key 用户走
   `model_providers` 自定义 provider 与复用的 `/channel` 渠道界面。

---

## 1. 目标、非目标与设计原则

### 1.1 目标

- `dsh-tui --backend codex`（及 `/kernel` 选择）启动的会话，具备 Codex 官方 TUI 的全部日常
  能力：流式回复与思考摘要、命令/补丁/MCP/网页搜索工具卡、审批、问卷、Plan 模式与计划评审、
  插话（steer）/排队/打断、模型与思考强度、权限预设、压缩、上下文与额度、会话浏览/恢复/
  fork/回退/改名/归档、`!` shell、图片输入、子代理、`/review`、`/diff`、目标（goal）、
  skills、MCP 状态。
- 会话与官方 `codex` 互通：dsh-tui 建的 thread 能被 `codex resume` 打开，反之亦然。
- DSH 与 Claude 体验零回归：投影黄金基线不动，所有既有门禁全绿。

### 1.2 非目标（本期不做）

- 不把 Codex 的 Rust 核心嵌入 Node 进程（见 D1）。
- 不管理共享 app-server daemon 的启动、停止或远程控制；原生恢复的空闲写锁冲突可经
  官方 `app-server proxy` 重连本地既有 thread。
- 不实现 realtime 语音、Codex Cloud、插件市场管理、Windows 沙箱安装向导、
  userVerification、attestation。
- 不替用户修改 `~/.codex/config.toml`（Codex 自己因用户决定而写的规则除外，见 D6）。

### 1.3 原则（冲突时按此顺序取舍）

1. **显示体验第一**：信息与官方 TUI 对等（该看到的都看得到），呈现用 dsh-TUI 自己的设计语言
   与组件，不做像素级仿制。
2. **真源投影**：Codex 的持久化 thread 是 transcript 真源；不插入可能与持久化分歧的乐观事实；
   live 与回放走**同一个** item 映射函数（§7.1），并用 live≡replay 测试守住（§10.4）。
3. **复用优先、维护最小**：能用现有卡片/面板/能力就不新建；中立层扩展只做后端无关、未来
   ACP 也能受益的形状；Codex 专有逻辑只在 `src/backends/codex/`。
4. **能力缺席即明说**：不支持的就不声明能力，界面显示"当前后端不支持"，不做静默 no-op，不发
   假事件。
5. **协议变化快，入口要窄**：所有协议访问经 `rpc/` 与 `protocol/`；未知方法/通知/item 一律
   忽略并记调试日志，绝不崩。

---

## 2. 已验证事实（实测与源码）

标注：`[live]` 实测（中转站 + `gpt-5.6-terra` low），`[src]` 0.160.1 源码，`[types]` 生成类型。
fixture 名指 `scripts/fixtures/codex/wire/` 下的录制（C0 已脱敏入库）。

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `initialize` 在 spawn 后约 470 ms 返回 `{userAgent, codexHome, platformFamily, platformOs}`；之后 `model/list` 2–4 ms、`thread/start` ~50 ms | [live] probe-handshake |
| F2 | 握手后会收到 `configWarning`、`remoteControl/status/changed`；Linux 无 bubblewrap 时 stderr 报错（沙箱降级） | [live] |
| F3 | `model/list` 不需登录即返回内置目录（默认 `gpt-6.1-sol`；每个模型带 `supportedReasoningEfforts`、`defaultReasoningEffort`、`inputModalities`、`hidden`、`isDefault`） | [live] probe-models |
| F4 | `collaborationMode/list` → `Plan`/`Default`；`permissionProfile/list` → `:read-only`/`:workspace`/`:danger-full-access` | [live] |
| F5 | 状态存 sqlite（`state_5.sqlite` 等），历史为分页模式（`historyMode: "paginated"`）；**离线读取必须走 app-server**，不能解析文件 | [live] |
| F6 | 自定义 provider（`model_providers.<id>` + `env_key` + `wire_api="responses"`）下 `account/read` 返回 `requiresOpenaiAuth:false`，无需登录 | [live] probe-relay-turn |
| F7 | 简单回合时序：`thread/status/changed` → `turn/started` → `item/started+completed{userMessage}` → `item/started{agentMessage phase=final_answer}` → `item/agentMessage/delta`… → `item/completed` → `thread/tokenUsage/updated` → `account/rateLimits/updated` → `thread/status/changed` → `turn/completed{completed}` | [live] |
| F8 | 每回合基础输入约 9.4k token（系统提示+工具），中转站有缓存 | [live] |
| F9 | `userMessage` item 带回 `clientId` = 我们传的 `clientUserMessageId` | [live] s2 |
| F10 | `turn/steer{expectedTurnId}` 返回同一 `turnId`；插话作为新的 `userMessage` item 出现在**当前工具结束之后**（下一个步边界），带 `clientId` | [live] s2 |
| F11 | `turn/interrupt` 立即返回 `{}`，约 30 ms 后 `turn/completed{interrupted}`；**进行中的 commandExecution 只有 `item/started`，没有 `item/completed`，且不进历史** | [live] s2 |
| F12 | 命令审批：`item/started{commandExecution inProgress}` 后紧跟服务端请求 `item/commandExecution/requestApproval`，`itemId` 与 item 相同；应答后收到 `serverRequest/resolved{requestId}`；期间 `thread/status` 的 `activeFlags` 含 `waitingOnApproval` | [live] s1b |
| F13 | 命令被包成 `/bin/bash -lc '…'`；`commandActions[].command` 是解包后的原命令；`aggregatedOutput` 无输出时为 `null`；`source` 有 `unifiedExecStartup`/`userShell` 等 | [live] s1b/s3 |
| F14 | 文件改动审批 `decline` → item 以 `status:"declined"` 完成；新建文件的 `diff` 是**文件原文**；更新是**无文件头的 unified hunk**（`@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n`） | [live] s1/s2 |
| F15 | `turn/diff/updated{diff}` 给出整回合聚合 diff（供 `/diff`） | [live] s2 |
| F16 | `phase:"commentary"` 的 agentMessage 出现在工具前（过程说明），`final_answer` 在最后 | [live] s2 |
| F17 | `thread/shellCommand` 自成一个回合：`commandExecution{source:"userShell"}`，有输出 delta，进历史 | [live] s3 |
| F18 | 第三方客户端建的 thread 在 `thread/list` 里 `source:"vscode"`、`originator`=clientInfo.name；`preview`=首条用户输入；`name` 初始为 `null` | [live] s3 |
| F19 | `thread/resume{excludeTurns:true}` 返回 `model/modelProvider/reasoningEffort/approvalPolicy/sandbox/activePermissionProfile/collaborationMode/multiAgentMode/initialTurnsPage/turnsBackwardsCursor` 等全部状态栏所需字段 | [live] s3 |
| F20 | `thread/turns/list{sortDirection:"desc"}` 新→旧分页；**默认 `itemsView:"summary"` 会省略 item**（userShell 回合为空），回放必须用 `itemsView:"full"` | [live] s3 |
| F21 | `thread/name/set` → `thread/name/updated`；`thread/fork{lastTurnId}` → 新 thread（`forkedFromId`），含截止该回合的历史；`thread/revert{beforeTurnId}` **原地**删除该回合及之后；`thread/archive` 后 `thread/list` 不再列出 | [live] s3 |
| F22 | `thread/compact/start` 自成回合：`item/started{contextCompaction}` … `item/completed` → `warning` → `turn/completed` | [live] s3 |
| F23 | Plan 模式经 `turn/start.collaborationMode`（实验字段）设置，持久化到 thread（resume 可见）；`item/tool/requestUserInput` 问卷形状 `{questions:[{id,header,question,isOther,isSecret,options:[{label,description}]}], isBlocking, autoResolutionMs}`；应答 `{answers:{<id>:{answers:[label…]}}}`；**问答不写进历史** | [live] s4 |
| F24 | Plan 模式结束产出 `plan` item（`item/plan/delta` 流式 markdown）；官方 TUI 随后弹出客户端合成的 "Implement this plan?"（实施 / 清空上下文后实施 / 留在 Plan） | [live] s4, [src] tui/chatwidget/plan_implementation.rs |
| F25 | 子代理：父 thread 出现 `subAgentActivity{kind:"started", agentThreadId, agentPath}` / `collabAgentToolCall{tool:"wait"}` / `subAgentActivity{kind:"completed"}`；**子 thread 的通知走同一连接**；`thread/read` 子 thread 得 `parentThreadId`、`agentNickname`、`source.subAgent.thread_spawn{depth,agent_path}`；`thread/list` 默认不列子 thread | [live] s5 |
| F26 | 功能开关：`multi_agent`、`goals`、`hooks`、`image_generation`、`shell_tool` 默认开；**`update_plan` 工具默认关**（需 `[tools.update_plan] enabled=true`） | [live] features list, [src] core/config |
| F27 | 外部 ChatGPT 令牌：`account/login/start{type:"chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType?}` 装入内存中的 `ExternalAuthBridge`；app-server 需要时发服务端请求 `account/chatgptAuthTokens/refresh{reason, previousAccountId?}`，**10 秒超时**，应答 `{accessToken, chatgptAccountId, chatgptPlanType}` | [src] app-server/src/external_auth.rs, account_processor.rs |
| F28 | 官方审批选项文案与决策：命令 `Yes, proceed`(accept) / `Yes, and don't ask again for commands that start with …`(acceptWithExecpolicyAmendment) / `… for this command in this session`(acceptForSession) / `No, continue without running it`(decline) / `No, and tell Codex what to do differently`(cancel)；文件 `Yes, proceed` / `Yes, and don't ask again for these files`(acceptForSession) / `No, and tell Codex what to do differently`(cancel) | [src] tui/bottom_pane/approval_overlay.rs |
| F29 | 中转请求可能静默卡住（无 error、无重试，90 s 无任何通知）；同一连接上的其他 thread 不受影响 | [live] s1 T1 |
| F30 | pi-ai 的 `openai-codex` 登录从访问令牌 JWT 的 `https://api.openai.com/auth.chatgpt_account_id` 解出账户 id（`chatgpt_plan_type` 同处） | [src] pi-ai dist/auth/oauth/openai-codex.js |

---

## 3. 关键决策（D-CX）

| # | 决策 | 理由 / 否决的方案 |
| --- | --- | --- |
| D1 | 传输用 app-server v2：独立进程走 stdio JSON 行；本地 daemon 的官方 proxy 走 stdio 承载的 WebSocket 帧，用通用 `ws` 编解码 | 否决 `@openai/codex-sdk`（exec 包装，无审批/steer/原地中断）、`codex mcp-server`（工具化接口，丢失 item 粒度）、napi 嵌入 Rust 核心（6 平台构建、跟踪不稳定内部 API、与用户安装版本脱节） |
| D2 | 每组可互换的启动设置一个 `CodexHub`（一条连接，多 thread）；引用计数，最后一个使用者释放后 30 s 空闲关闭；崩溃自动重启并 `thread/resume` 仍在用的 thread；原生恢复的空闲写锁冲突可重连既有本地 daemon | 设置指纹隔离凭据与 provider；关闭 proxy 只断开本客户端，不停止 daemon |
| D3 | 协议类型入库：`src/backends/codex/protocol/generated/`（`generate-ts --experimental` 原样输出）+ 手写 `protocol/index.ts` 只 re-export 用到的类型；`contract.ts` 记 `VALIDATED_CODEX_VERSIONS` 与生成目录哈希 | 零运行时依赖；升级 = 跑同步脚本 + 看 diff。**不加 `@openai/codex` devDependency**（平台二进制巨大）；同步脚本接收 `--bin <codex>` |
| D4 | `initialize.capabilities.experimentalApi = true`；用到的实验面：`turn/start.collaborationMode`、`collaborationMode/list`、`thread/settings/update`（V11）、`thread/backgroundTerminals/*`。每个实验调用都有退路：`-32601`/`-32602` → 关闭对应能力并提示一次 | Plan 模式是核心体验，只能走实验字段 |
| D5 | 身份：`sessionId = threadId`；挂载账本 `codex:<threadId>`；恢复命令 `dsh-tui --backend codex --resume <id>`（也提示 `codex resume <id>`） | 与 Claude 一致 |
| D6 | `CODEX_HOME` 用用户自己的（尊重已设置的 `CODEX_HOME` 环境变量，否则 `~/.codex`）。dsh-tui **不写** `config.toml`；`/model`、`/effort`、`/permission`、Plan 模式等选择存 `~/.dsh-tui/backends/codex/prefs.json`，经 `thread/start`/`turn/start` 参数逐 thread 生效。Codex 因用户审批决定而自己持久化的规则（execpolicy amendment）照常 | 保真（AGENTS.md、MCP、skills、hooks、provider 都按官方方式加载）+ 会话互通；"TUI 不写 CLI 设置"与 Claude 后端同一原则 |
| D7 | 凭据顺序：①`/channel` 激活的渠道连接 → ②内置 OAuth `openai-codex`（外部令牌，仅第一方路由）→ ③用户自己的 `~/.codex` 登录 / `OPENAI_API_KEY` / `CODEX_API_KEY` / config 里的自定义 provider（环境原样透传）→ ④都没有：`/login` | 与 Claude 后端一致的优先级与"只在第一方路由注入"安全原则 |
| D8 | 用户消息不乐观插入：`item/started{userMessage}` 且 `clientId` 匹配时才落行并认领 pending | 真源投影 |
| D9 | `followup` 用**客户端队列**（回合结束后由会话发出 `turn/start`）；不用实验的 `thread/queue/*` | Channel 需要确定的取消回执（`CancelReceipt.outcome:'confirmed'`），客户端队列天然确定 |
| D10 | "拒绝并附理由" = `cancel` 决策 + 把理由作为 followup 新回合发送（官方 TUI 的 "tell Codex what to do differently" 语义）；无理由拒绝 = `decline` | 不改中立层；与官方一致 |
| D11 | Plan 模式作为 `modes` 的一员；plan item 完成后由后端合成计划评审问题（复用 `PlanReviewIntentView` 面板） | 与官方 TUI 流程一致 |
| D12 | 只读命令（`commandActions` 全为 read/search/listFiles）用 read/search 卡片呈现；其余为终端卡 | 信息对等（官方 TUI 的 "Explored" 汇总）且复用现有卡片 |
| D13 | 会话浏览器的"删除" = `thread/archive`（可恢复）；标签文案写"归档" | 防误删；官方 CLI 也区分 archive/delete |
| D14 | 后端自有斜杠命令（`/review`、`/diff`、`/plan`、`/usage`、skills）在会话 `submit` 内部识别执行，经 `commands.list()` 进入菜单；与本地命令重名的（如 `/init`）走能力（N9） | 不改中立层（`commands` 能力已把 backend 命令作为文本提交给会话）；本地名字优先是核心既定规则（§5.16、§8.6） |
| D15 | 新增 `src/backends/shared/`：后端无关、无厂商依赖的共享件（原子写、渠道令牌库）；边界规则：任何后端可 import，shared 不 import 任何具体后端或厂商包；后端之间禁止互相 import | 避免 Codex 复制 Claude 的通用代码 |
| D16 | 实测只用中转站 `gpt-5.6-terra` + `low`（不行再 `gpt-6-sol` + `low`），由守卫脚本强制 | 维护者的成本规则 |

---

## 4. 架构总览

### 4.1 分层与数据流

```text
界面（screens/components/ink）── 只读 ChannelUi，不感知后端
        │
Channel 核心（dsh-adapter/channel/core）── 不改；按 SessionCapabilities 委托
        │ AgentSession · AgentEvent
src/backends/codex/
  backend.ts ── AgentBackend('codex')：detect / open / catalog / launch
  session/   ── CodexSession（一个 thread）：输入、取消、能力
  translate/ ── ThreadItem / 通知 → AgentEvent（live 与回放同一映射）
  rpc/       ── CodexHub：一个 `codex app-server` 子进程，一条 JSON-RPC 连接，按 threadId 路由
        │ stdio JSON 行
codex app-server（用户安装的 codex 二进制；CODEX_HOME=用户的）
```

一条消息的旅程：子进程 stdout 一行 → `rpc/client.ts` 解析 → 响应配对或按 `threadId` 投递给
`CodexSession` → `translate/live.ts` 有状态地翻成 `AgentEvent[]` → `session.subscribe` 的
监听者（channel）→ 共享投影器 → 界面。服务端请求（审批/问卷/刷新令牌）走同一路由，由会话的
`approvals.ts` 或 hub 的 `auth` 应答。

### 4.2 目录

```text
src/backends/codex/
  index.ts                 导出 codexBackend 与 contract 常量（唯一对外入口）
  contract.ts              VALIDATED_CODEX_VERSIONS、PROTOCOL_DIGEST、版本比较与 drift 文案
  protocol/
    generated/             generate-ts --experimental 原样输出（勿手改；有 README 说明来源与版本）
    index.ts               只 re-export 本后端用到的类型；方法名常量表（HANDLED_*）
  narrow.ts                unknown 收窄工具（rec/str/num/arr/bool），对标 claude/narrow.ts
  rpc/
    transport.ts           spawn、行分帧、写队列、stderr 折叠、退出处理
    client.ts              JSON-RPC 请求/响应/通知/服务端请求；超时；错误类型
    hub.ts                 CodexHub：握手、引用计数、空闲关闭、崩溃重启、thread 路由、全局通知
    binary.ts              可执行文件解析与版本读取
  backend.ts               AgentBackend 实现
  detect.ts                安装/版本/凭据可用性检测
  catalog.ts               SessionCatalog（thread/list/read/name/archive）
  prefs.ts                 ~/.dsh-tui/backends/codex/prefs.json
  channels.ts              Codex 渠道配置（~/.dsh-tui/backends/codex/channels.json）与启动覆盖
  auth/
    route.ts               第一方路由判定（只在 OpenAI 第一方注入令牌）
    external-tokens.ts     chatgptAuthTokens 登录与刷新应答（JWT 声明解析）
    status.ts              /login 状态行
  session/
    session.ts             openCodexSession → AgentSession（组装下列部件）
    state.ts               会话可变状态（turn、open items、pending 队列、设置快照）
    input.ts               四种 placement、客户端 followup 队列、取消回执
    approvals.ts           审批/问卷/elicitation/计划评审 → permission.* / question.*
    controls.ts            models/effort/modes/compact/context/account/mcp/commands/rename/color/diagnostics
    history.ts             history()、transcript 能力（分页预取）
    subagents.ts           子 thread 路由与 subagents 能力
    tasks.ts               后台终端 → tasks 能力（实验接口，带退路）
    goals.ts               thread/goal ↔ goal 能力
    commands.ts            后端自有斜杠命令（/review /diff /init、skills）
    side-query.ts          /btw（ephemeral fork）
    images.ts              图片输入（data URL）与 images 能力限制
  translate/
    items.ts               ThreadItem → AgentEvent[]（纯函数，live/回放共用）
    live.ts                通知流状态机（attempt/step、delta、open items、settle）
    replay.ts              Turn[] → AgentEvent[]（调用 items.ts，按回合重建 attempt/step）
    presentation.ts        工具卡 presentation（终端/读/搜/diff/通用）
    commands.ts            commandActions 解析、命令解包（/bin/bash -lc '…'）
    notices.ts             warning/error/codexErrorInfo → 本地化 notice（带 key 去重）
    usage.ts               tokenUsage → context.*；rateLimits → rate-limit
src/backends/shared/       （D15，新）
  atomic-file.ts           从 claude/atomic-file.ts 迁来
  channel-tokens.ts        从 claude/channelTokens.ts 迁来（通用化命名）
```

所有对外暴露只经 `index.ts`；`dsh-adapter/backends.ts` 只以动态 `import()` 加载它（DSH-only
启动零成本）。

---

## 5. 模块设计

### 5.1 `rpc/transport.ts`

```ts
export interface TransportOptions {
  readonly executable: string            // binary.ts 解析结果
  readonly args: readonly string[]        // ['app-server', ...configOverrides]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly onLine: (line: string) => void
  readonly onStderr: (line: string) => void
  readonly onExit: (info: { code: number | null; signal: string | null }) => void
}
export interface Transport { write(line: string): void; close(): Promise<void>; readonly pid: number | undefined }
export function spawnTransport(options: TransportOptions): Transport
```

- `child_process.spawn(executable, ['app-server', ...overrides], { stdio: ['pipe','pipe','pipe'], env, cwd, windowsHide: true })`。
  stdout 用 `readline` 按行切；单行上限 64 MiB（超限丢弃该行并记调试日志）。
- 写入走队列，尊重 `write()` 返回值与 `drain`。
- stderr 逐行交 `host.stderr`（宿主折叠为提示，绝不进终端）；已知噪声（bubblewrap 缺失、
  PATH aliases 警告）由 `diagnostics` 归纳为 `/doctor` 行，不弹提示。
- `close()`：先 `stdin.end()`，2 s 未退出 `SIGTERM`，再 2 s `SIGKILL`。**C0 已验证**（V1）：
  stdin EOF 后约 70 ms 以 code 0 自行退出。
- 环境：从 `process.env` 复制，删除父级 Codex 会话导出的变量，保留 `CODEX_HOME`；渠道与凭据注入见
  §5.10/§5.11。**C0 已验证**（V2）清单：`CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_VERSION`、
  `CODEX_CI`、`CODEX_SANDBOX`、`CODEX_SANDBOX_NETWORK_DISABLED`、`CODEX_PERMISSION_PROFILE`、
  `CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS`、`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`、
  `CODEX_MANAGED_BY_*`、`CODEX_MANAGED_PACKAGE_ROOT` 与前缀 `CODEX_NETWORK_PROXY_`。

### 5.2 `rpc/client.ts`

```ts
export type RequestId = number | string
export class CodexRpcError extends Error { readonly code: number; readonly data: unknown }
export interface RpcClient {
  call<R = unknown>(method: string, params: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<R>
  notify(method: string, params?: unknown): void
  onNotification(listener: (method: string, params: unknown) => void): () => void
  onServerRequest(handler: (id: RequestId, method: string, params: unknown) => Promise<unknown> | undefined): void
  respond(id: RequestId, result: unknown): void
  respondError(id: RequestId, code: number, message: string): void
  close(reason: Error): void            // 所有挂起请求以 reason 拒绝
}
```

- 请求 id 用自增整数。默认超时：普通请求 30 s；`turn/start`/`turn/steer`/`thread/resume`
  60 s；`thread/compact/start` 120 s（响应只是受理，回合本身靠通知）。超时抛
  `CodexRpcError(code:-32000,'timeout')`，**不**杀进程。
- 服务端请求（消息同时带 `id` 与 `method`）交给注册的 handler；handler 返回 `undefined` 表示
  "稍后由别处 `respond`"（审批/问卷挂起时）。未知服务端请求立即 `respondError(-32601)`。
- 解析失败的行、未知通知：调试日志后丢弃。
- 生成类型只用于给 `call` 的调用点标注参数/结果类型（`call<ThreadStartResponse>(…)`）；
  结果在使用处一律经 `narrow.ts` 收窄（生成类型里的 `bigint` 字段在 JSON 里是 number）。

### 5.3 `rpc/hub.ts`：`CodexHub`

```ts
export interface ThreadSink {
  notification(method: string, params: Rec): void
  serverRequest(id: RequestId, method: string, params: Rec): Promise<unknown> | undefined
  connectionLost(error: Error): void
  connectionRestored(): void              // hub 重启后，会话自行 thread/resume
}
export interface CodexHub {
  readonly ready: Promise<InitializeInfo>  // { userAgent, codexHome, platformOs, version }
  call<R>(method: string, params: unknown, options?): Promise<R>
  attach(threadId: string, sink: ThreadSink): () => void   // 返回 detach
  retain(): () => void                     // 引用计数；release 后 30 s 空闲关闭
  onGlobal(listener: (method: string, params: Rec) => void): () => void
  readonly account: AccountState           // account/read 缓存 + rateLimits 快照 + auth 状态
}
export function acquireCodexHub(host: BackendHost, settings: HubSettings): CodexHub   // 进程级单例（按 settings 指纹）
```

- **握手**：`initialize{clientInfo:{name:'dsh-tui', title:'dsh-TUI', version:<包版本>}, capabilities:{experimentalApi:true, requestAttestation:false, optOutNotificationMethods:[…]}}`
  → 发 `initialized` 通知。`optOutNotificationMethods` 屏蔽我们不处理的高频通知：
  `rawResponseItem/completed`、`rawResponse/completed`、`fs/changed`、全部 `thread/realtime/*`、
  `fuzzyFileSearch/*`、`externalAgentConfig/*`、`app/list/updated`。
- **路由**（**评审修订**：不依赖到达顺序）：带 `threadId`（或 `thread.id`）的通知/服务端请求
  投递给 attach 的 sink。未 attach 的 thread（子代理，可能多层）：
  1. 快路径：父会话看到 `subAgentActivity{started}` / collab `receiverThreadIds` 时预登记
     `childThreadId → 父会话`（§5.13）。
  2. 兜底：仍未知的 threadId → hub 调 `thread/read{threadId, includeTurns:false}` 取
     `parentThreadId`（结果缓存），沿父链找到已 attach 的**根会话**后投递；查询期间该 thread 的
     消息按到达顺序缓冲（每 thread 上限 1000 条，超出丢最旧通知并记调试日志），**服务端请求一并
     缓冲、绝不直接拒绝**（否则子代理的审批会静默失败）。
  3. 父链查不到（真孤儿）：通知调试日志后丢弃；服务端请求以 `-32603` 应答并给根会话（若有）一条
     warning notice。
- **诊断广播**（**评审修订**）：hub 级的调试日志、stderr 行与"缺 bubblewrap"等一次性诊断广播给
  **所有** attach 的会话（不归第一个打开者），`/doctor` 在任何会话里都完整。
- **全局通知**：`account/rateLimits/updated`、`account/updated`、`account/login/completed`、
  `mcpServer/startupStatus/updated`、`skills/changed`、`configWarning`、`deprecationNotice`、
  `warning{threadId:null}`、`model/verification` 交 `onGlobal`；会话订阅需要的部分。
- **指纹与多实例**：渠道（不同 base_url/env）或凭据模式不同的会话需要不同的 app-server
  （provider 是进程级配置）。`HubSettings` 计算指纹（`-c` 覆盖 + 注入环境的键名与值哈希），
  同指纹复用、不同指纹各起一个 hub。切渠道 = 新 hub + `thread/resume`（与 Claude 切渠道需重启
  CLI 等价）。
- **崩溃恢复**：子进程非预期退出 → 所有挂起请求拒绝 → 对每个 sink `connectionLost` → 退避
  （0.5 s、2 s、5 s，最多 3 次）重启并握手 → `connectionRestored`，会话以 `thread/resume`
  重新订阅并补齐（§9.2）。3 次失败后会话进入 `disposed` 前的错误态并提示。
- **空闲关闭**：retain 计数归零 30 s 后关闭；期间新的 retain 取消计时。进程退出漏斗
  （`ctx.effect` 或既有的单一退出路径）里调用 `closeAllCodexHubs()`（**评审遗留**：C1 已实现该函数
  但尚未接入退出漏斗，C2 第一项补上）。

### 5.4 `rpc/binary.ts` 与 `detect.ts`

- 可执行文件：`CODEX_EXECUTABLE` 环境变量 → `PATH` 上的 `codex` → 都没有则未安装。
  **评审修订**（Windows）：`PATH` 上找到的若是 npm 的 `codex.cmd` 包装，解析到 npm 包内真正的
  `codex.exe` 再启动——经 `cmd.exe` 转发会按 `""` 规则改写参数，破坏 `-c key="value"`。
- 版本：`codex --version` → `codex-cli X.Y.Z`；不在 `VALIDATED_CODEX_VERSIONS` 范围内 →
  `drift`（只提示不阻断）。范围策略：同一 minor 线上 ≥ 验证版本视为兼容（0.160.x），跨 minor
  提示 drift；最低支持版本 `MIN_CODEX_VERSION`（**C0 已验证**，V16：`0.144.0`——其生成协议覆盖
  本后端用到的全部名字，`thread/revert` 本后端不用；低于它 `installed:false` 并给升级提示）。
- `detect()` 返回 `BackendDetection`：
  - `installed` / `version` / `drift` / `hint`（未安装时：`npm i -g @openai/codex` 或
    `brew install codex`）。
  - `auth`：不起进程的廉价判断——激活渠道有连接 → `ok`；内置 OAuth `openai-codex` 已存 →
    `ok`；`OPENAI_API_KEY`/`CODEX_API_KEY` 已设 → `ok`；`$CODEX_HOME/auth.json` 存在 → `ok`；
    `$CODEX_HOME/config.toml` 存在且含 `model_provider =`（非 openai，粗略文本匹配）→ `ok`；
    凭据存储为钥匙串或 `auto`（`cli_auth_credentials_store = "keyring" | "auto"`）且没有
    `auth.json` → `unknown`（**评审修订**：已登录用户不能被判成 missing）；否则 `missing`。
    `missing` 不置灰：Codex 声明 `loginInSession`（N7），内核行可选并提示"启动后用 /login 登录"。
  - 版本低于 `MIN_CODEX_VERSION`：独立的"版本过旧"原因并保留升级 hint（**评审修订**：不能显示成
    "未安装"——Codex 没有安装向导，用户需要知道该升级）。

### 5.5 `backend.ts`

```ts
export const codexBackend: AgentBackend = {
  id: 'codex',
  descriptor: { label: 'Codex' },
  detect,                                   // detect.ts
  open,                                     // 下文
  catalog: codexCatalog,                    // catalog.ts
  launch: { sessionPrefs, resumeCommand: id => `dsh-tui --backend codex --resume ${id}` },
}
```

`open(target, host)`：
1. `acquireCodexHub(host, settingsFromPrefsAndChannel())`，`await hub.ready`（≈0.5 s，冷启动
   唯一一次）。
2. 凭据（§5.10）：必要时 `account/login/start{chatgptAuthTokens}`（每个 hub 一次）。
3. `create`：`thread/start{cwd, model?, effort?, approvalPolicy?, sandbox?, serviceName:'dsh-tui'}`。
   **设置优先级**（每项独立）：dsh-tui prefs 里用户显式选过的 > 用户 `config.toml` 里设置的（hub
   握手后 `config/read` 一次得知：`approval_policy`/`sandbox_mode`/`model`/`model_reasoning_effort`
   是否非空）> 内置默认（权限档 `auto`，其余不传、交给 Codex）。只有落到"内置默认"的项才由我们
   传参——绝不覆盖用户自己的 config（**评审修订**，原写法会无条件传 `auto`）。
   `resume`：`thread/resume{threadId, excludeTurns:true, cwd?, initialTurnsPage…}`，失败（`-32600
   not found` / `already has an active writer`）抛本地化错误。
4. 用响应里的设置快照建 `CodexSession`（§5.6），`hub.attach(threadId, session.sink)`。
5. `session.ready` 事件由会话在 `subscribe` 之前排队：`session.ready{sessionId, cwd, model, provider, title, permissionMode, effort, contextWindow?, backendVersion}`。

**C0 已验证**（V3）：`thread/start` 带不带 `serviceName` 都是 `source:"vscode"`；官方
`codex resume` 选择器默认 `sourceKinds:[cli, vscode]`，并按用户的默认 provider 与 cwd 过滤，所以
dsh-tui 建的 thread 会被列出（provider 不同时需在选择器里切"全部 provider"）。open 不需要额外参数。

### 5.6 `session/session.ts` 与 `state.ts`：`CodexSession`

`AgentSession` 的实现。状态：

```ts
interface CodexSessionState {
  threadId: string
  cwd: string
  status: AgentSessionStatus                 // starting|idle|running|requires-action|disposed
  activeTurnId: string | undefined           // turn/started 设置，turn/completed 清空
  turnKind: 'user' | 'shell' | 'compact' | 'review' | undefined
  settings: SettingsSnapshot                 // model, provider, effort, approvalPolicy, sandbox, collaborationMode
  pending: PendingInput[]                    // 客户端 followup 队列（D9）+ 已发出未确认的 steer
  openItems: Map<string, OpenItem>           // 已 started 未 completed 的 item（中断时收尾）
  pendingRequests: Map<RequestId, PendingRequest> // 挂起的审批/问卷（serverRequest/resolved 结算）
  childThreads: Map<string, ChildLane>       // 子代理 thread → lane 状态
  disposed: boolean
}
```

- `status` 由 `thread/status/changed` 驱动：`active` → `running`（`activeFlags` 含
  `waitingOnApproval`/`waitingOnUserInput` → `requires-action`）；`idle` → `idle`；
  `systemError` → `idle` + error notice；同时发 `session.status` 事件。
- `subscribe(listener)`：注册后先同步回放排队的 `session.ready` 等启动事件；之后 live。
  事件批次带 `AgentEventMeta.wake`：`item/agentMessage/delta`、`item/reasoning/*Delta`、
  `item/plan/delta`、`outputDelta` → `'frame'`；仅 `session.status`/`pending.changed` → `'none'`；
  其余 `'sync'`（与 Claude `wakeOf` 同策略）。
- `dispose()`：拒绝/撤回所有挂起请求（审批面板收起）→ 若回合进行中 `turn/interrupt` →
  `thread/unsubscribe` → `hub.detach` → `release()`。幂等。

### 5.7 `session/input.ts`：输入放置与取消

`submit(input, placement)`：

| placement | 空闲 | 回合进行中 |
| --- | --- | --- |
| `turn` | `turn/start` | 当作 `followup` |
| `steer` | `turn/start` | `turn/steer{expectedTurnId: activeTurnId}`；失败码为 `activeTurnNotSteerable`（`codexErrorInfo`）或 turn 已变 → 降级为 `followup` 并 `notice` 一次 |
| `followup` | `turn/start` | 入客户端队列，`pending.changed` 显示；`turn/completed` 后按 FIFO 逐个 `turn/start`（一次只发一个，等它的 `turn/started` 再发下一个前不再发） |
| `now` | `turn/start` | `turn/interrupt`，等 `turn/completed` 后 `turn/start`（等待上限见下方"强制收尾"） |

**队列顺序**（**评审修订**）：`now` 项 → 被这次中断丢弃、按 `user` 取消语义重新排队的 steer →
其余 followup。`now` 永远是中断后发出的第一个回合。

**强制收尾**（**评审修订**）：`turn/interrupt` 后 15 s 仍没有 `turn/completed` → 本地结算该回合
（open items 以 interrupted 收尾、`turn.end{interrupted}`、notice），并把该 `turnId` 记入
`closedTurns`（有界，保留最近 64 个）。之后属于已关闭回合的任何 item/delta/`turn/completed`
一律丢弃——否则迟到的 `item/completed` 会开出"幽灵回合"，下一条用户消息落进没有 `turn.start`
的回合里。

- 每次发送带 `clientUserMessageId = input.clientMessageId`。`UserInput[]` 由 `input.blocks`
  （或 `input.text`）组成：文本合并为一个 `{type:'text', text, text_elements:[]}`；图片按块序
  追加 `{type:'image', url:'data:<mime>;base64,…'}`（§5.17）；`@` 提及的文件已由 channel 展开为
  文本块，原样发送；skill 引用见 §5.16。
- 只有 `item/started{userMessage}` 带回相同 `clientId` 时才认领 pending（`pending.changed{claimed}`）
  并产出 `user.message`（D8）。`turn/start` 失败 → 移除该 pending 并返回
  `{accepted:false, reason}`。
- 每次 `turn/start` 都携带当前的覆盖（`model`、`effort`、`approvalPolicy`、`sandboxPolicy`、
  `collaborationMode`）——只在与 thread 当前设置不同的时候才带，带了即对后续回合生效（协议语义）。

`cancel(cause)`：
- 有活动回合：`turn/interrupt{threadId, turnId}`。
- `user`：客户端队列保留（回合结束后继续发）→ 回执 `{stillQueued: 队列 id, outcome:'confirmed'}`。
- `interrupt`：清空客户端队列，被丢弃的作为 dock（channel 处理）→ 回执
  `{stillQueued: [], outcome:'confirmed'}`（队列在本进程，确定）。
  **C0 已验证**（V6）：已经 `turn/steer` 发出、但中断前还没被采纳（没出现对应 `userMessage`）的
  输入被 Codex 丢弃（不进历史、中断后不自动开回合）。所以回执始终 `confirmed`、不含这些 id；
  `user` 取消时会话把它们按原顺序重新排进客户端 followup 队列（"排队的输入下回合照跑"），
  `stillQueued` 同时列出它们。
- `switch`/`dispose`：中断并撤回挂起请求，不再发队列。
- 中断后的 `turn/completed{interrupted}`：所有 `openItems` 以 interrupted 收尾（§7.4）。

### 5.8 `session/approvals.ts`：审批、问卷、elicitation、计划评审

服务端请求 → 视图：

| 服务端请求 | 视图 | 选项（`PermissionOptionView`） |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `permission.request{requestId:'codex:'+id, toolName:'shell', callId:itemId, command:<解包命令>, reason, displayName:t('tool-name-bash'), feedback:true, defaultToNo:false}` | **按服务端的 `availableDecisions` 生成**（C0 已验证：服务端常不提供 decline/acceptForSession；缺省集同官方 TUI：accept、有 amendment 时 execpolicy、cancel）：`accept`→`allow-once` · `acceptWithExecpolicyAmendment`→`allow-always` id=`execpolicy` label=`t('codex-approve-prefix',{prefix})`（prefix 含换行则不提供，同官方）· `acceptForSession`→`allow-always` id=`session` label=`t('codex-approve-session-command')` · `applyNetworkPolicyAmendment`→每条一个 `allow-always` id=`net:<i>` · `decline`/`cancel`→一个 `reject`（无理由：有 decline 用 decline，否则 cancel；带理由：cancel + followup，D10） |
| `item/fileChange/requestApproval` | `permission.request{toolName:'apply_patch', callId:itemId, reason, blockedPath:grantRoot?, displayName:t('tool-name-edit'), feedback:true}` | `allow-once`(accept) · `allow-always` id=`session` label=`t('codex-approve-session-files')`(acceptForSession) · `reject` |
| `item/permissions/requestApproval` | `permission.request{toolName:'permissions', description:<RequestPermissionProfile 摘要>, reason}` | `allow-once` → `{permissions:<请求的全部>, scope:'turn'}` · `allow-always` id=`session` → `scope:'session'` · `reject` → `{permissions:{}, scope:'turn'}` |
| `item/tool/requestUserInput` | `question.request{requestId, callId:itemId, questions: 每个 question 一项：header、question、options(label/description)、`hideCustomInput: !isOther`、`secret: isSecret`（N3）}` | 应答 `{answers:{<qid>:{answers:[选中 label…, 自定义文本?]}}}`；取消（**C0 已验证**，V7：错误应答与 `{answers:{}}` 等价，官方 TUI 的 Esc 是中断回合）→ 应答 `{answers:{}}` 并 `turn/interrupt`；`autoResolutionMs` 非空时到点自动以首选项应答并 notice |
| `mcpServer/elicitation/request` | 经中立的 `src/channel/elicitation.ts`（N2，从 Claude 迁来）转 `question.request` | 应答 `{action:'accept'\|'decline'\|'cancel', content, _meta:null}`；URL 模式 → 链接问题（与 Claude 一致） |
| `account/chatgptAuthTokens/refresh` | 不进界面，hub 的 auth 处理（§5.10） | — |
| `applyPatchApproval` / `execCommandApproval`（v1 遗留） | 不应出现（v2 客户端）；出现则 `respondError(-32601)` 并调试日志 | — |
| `item/tool/call`、`attestation/generate`、`currentTime/read` | 不声明 dynamic tools / attestation：`respondError(-32601)`；`currentTime/read` 应答当前时间 | — |

- `permissions.respond(requestId, decision)`：映射见上表；发出后**不**立即发
  `permission.settled`，等 `serverRequest/resolved`（F12）或 item 完成再发，防止乐观状态。
  `reject` 带 `message` 时：应答 `cancel`，并把 message 作为 `followup` 入队（channel 会显示
  该用户行，D10）。
- `serverRequest/resolved` 到达而本地仍挂起（别的客户端或自动审查处理了）→
  `permission.settled{outcome:'cancelled'}` / `question.settled`，面板收起。
- `item/autoApprovalReview/started|completed`、`guardianWarning`：info notice（"自动审查中…/
  已批准/已拒绝"），不弹面板。
- **计划评审**（D11）：当前 `collaborationMode.mode === 'plan'` 且某回合以 `plan` item 结束、
  没有挂起请求时，后端合成 `question.request{requestId:'codex-plan:'+turnId, questions:[{question:t('codex-plan-implement'), detail:<plan markdown>, options:[{label:t('codex-plan-yes')},{label:t('codex-plan-clear')},{label:t('codex-plan-stay')}], hideCustomInput:false, intent:{kind:'plan-review', approve:t('codex-plan-yes'), approveAlso:[t('codex-plan-clear')], decline:t('codex-plan-stay')}}]}`。
  - 实施：模式切到 `default`，`turn/start{input:"Implement the plan.", collaborationMode:default}`。
  - 清空上下文后实施：`thread/start` 新 thread（同 cwd 与设置、default 模式）→ 会话**内部**
    换绑到新 thread（`hub.attach` 新 id、detach 旧 id，`ref` 随之变化）→ 发
    `session.reset{trigger:'clear-context'}`（核心已有的重置路径：清空行、子代理与任务并提示，
    与 Claude 的 conversation reset 同机制）→ `turn/start`，输入为官方前缀 + plan markdown
    （F24 的 `PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX` 原文）。原 thread 保留，可 `/resume`。
    不需要新的中立事件。实现前读核心对 `session.reset` 的处理与挂载账本，确认 ref 变化后账本键
    （`codex:<id>`）与"上次会话"标记随之更新（Claude 的 conversation reset 已走过这条路）。
  - 留在 Plan / 自定义文本：自定义文本作为 followup（仍在 plan 模式）。
  - 该合成问题**不进历史**（与官方一致）；恢复会话不再弹。
- 服务端请求 id 只在一条连接内唯一，hub 重启后会重复：视图 `requestId` 一律为
  `codex:<hub 代数>:<id>`，应答前校验代数，旧代数的应答丢弃。**C0 已验证**（V5）：对运行中的
  thread 再次 `thread/resume` 会以**同一 id** 重发挂起的请求——同代数同 id 视为重投，不弹第二个面板。
- **审批面板显示的必须是将要执行的东西**（**评审修订**）：`command` 用**无损**解包（§8.1 的
  shell 包装规则，能逆向还原才算无损）或原文，**绝不**用 `commandActions` 推断的子命令（例：
  `bash -lc 'cd src && cat a.ts | head -5'` 不能显示成 `cat a.ts`）；`commandActions` 只给卡片标题用。
  另外按请求字段显示：`kind:'writeStdin'`（写入的内容，而不是命令）、`networkApprovalContext`
  （目标主机与协议）、`additionalPermissions`（与权限审批同一摘要函数）、与会话 cwd 不同的 `cwd`。
- 子代理 thread 的审批照常弹面板，`agentId` = 子 thread id（路由见 §5.3）。

### 5.9 `session/controls.ts`：控制面能力

| 能力 | 实现 |
| --- | --- |
| `models` | `list()`：`model/list{includeHidden:false}` 缓存（hub 级，`model/verification`/`account/updated` 时失效）→ `ModelOption{id, label:displayName, description}`；`current()`：设置快照；`set(ref)`：存 prefs，下一次 `turn/start` 携带 `model`；若空闲则立即 `thread/settings/update`（**C0 已验证**，V11：空闲 thread 上改 model/effort/approval/sandbox 生效且持久化，发 `thread/settings/updated`）；发 `model.changed{source:'user'}` |
| `effort` | `levels()`：当前模型的 `supportedReasoningEfforts`（id=`reasoningEffort`，label 本地化 `effort-<id>`，未知 id 用原文）；`set` 同上经 `turn/start.effort`；`null` = 用模型默认 |
| `modes` | Codex 有**两个正交维度**：权限档（官方 `/permissions`）与协作模式（Default/Plan）。映射到单维的 `modes` 能力（**评审修订**，对齐官方手感）：`list()` = 权限三档 `auto`「Default」（`on-request` + `workspace-write`）、`read-only`「Read Only」（`on-request` + `read-only`）、`full-access`「Full Access」（`never` + `danger-full-access`）+ `plan`「Plan」——`/permission` 选择器显示全部四项。`current()`：协作模式为 plan 时返回 `plan`，否则返回当前权限档。`cycle()` = `[当前权限档, 'plan']`：**Shift+Tab 只切换 Plan 开关**（官方 `cycle_collaboration_mode` 的语义），进入 Plan 时保留权限档，退出时回到它；`full-access` 只能显式选（同 Claude bypass）。**C0 已验证**（V8，`utils/approval-presets`）：三档的组合、名称与 profile（`:workspace`/`:read-only`/`:danger-full-access`）同官方，label/description 照抄官方文案并本地化。`set(id)`：`plan` ↔ 其他改 `collaborationMode`；权限档改 approval/sandbox（协作模式回到 default）；空闲时 `thread/settings/update`（V11），否则经下一次 `turn/start` 覆盖；prefs 持久化；发 `mode.changed`。官方只在空闲时响应 Shift+Tab；dsh-TUI 沿用自己的按键规则（运行中切换在下一回合生效） |
| `compact` | `thread/compact/start`；进度来自 contextCompaction item |
| `context` | **按官方公式**（**评审修订**，`codex-rs/tui/src/token_usage.rs`）：占用 = 最近一次 `thread/tokenUsage/updated` 的 `last.totalTokens`；官方"剩余百分比"先扣 12000 的基线：`effective = window − 12000`、`used = max(0, last.totalTokens − 12000)`。为让上下文条的百分比与官方一致，Codex 发 `context.usage{used: max(0,last.totalTokens−12000), max: window−12000}`，由 N8b 让核心的占用读数优先采用它（现状：投影器忽略 `context.usage`，上下文条用"最近请求的计费样本 / 窗口"，三个后端都不发该事件，所以 N8b 对 DSH/Claude 零影响）；`/context` 明细行另列原始值（`last.totalTokens / window`）。`full` 同 summary（Codex 不提供分类明细，categories 为空） |
| `account` | `account/read` → `{provider: 'openai'\|'relay:<id>'\|providerId, subscription: planType, tokenSource: 'dsh-auth'\|'codex-login'\|'api-key'\|'channel'}`（不含邮箱） |
| `mcp` | `status()`：`mcpServerStatus/list{threadId, detail:'toolsAndAuthOnly'}` → `McpServerView{name, status, toolCount}`；`reconnect(name)`：`config/mcpServer/reload` 后重查；`toggle`：不声明（Codex 无运行时开关，改配置不在本期范围） |
| `commands` | `list()`：后端命令（§5.16）+ `skills/list{cwds:[cwd]}` 的 skills（`name`、`description`）；`skills/changed` → `commands.changed` |
| `rename` | `thread/name/set`；`thread/name/updated` → `session.title{source:'user'}`（本地发起）或 `'auto'` |
| `color` | prefs 按 thread 保存（上限 200，与 Claude 同实现，可复用 `src/backends/shared/` 的有界 map 写法） |
| `diagnostics` | `/doctor` 行：可执行文件路径与版本、drift、`codexHome`、凭据来源、bubblewrap（Linux：`which bwrap` 缺失时提示安装）、当前 provider 与 base URL 主机名（不含路径与密钥）。**评审修订**：Linux 缺 bubblewrap 且当前权限档需要沙箱（`auto`/`read-only`）时，会话打开后**在对话里**给一条 warning notice（含安装命令与"或切到 Full Access"），只提示一次（`key:'codex-bwrap'`）——只写进 `/doctor` 的话，用户只会看到命令莫名失败 |
| `workingActivity` | 不声明（用经典 spinner）；C4 可评估按 item 类型给出"运行 xx / 编辑 xx / 等待子代理"的活动行 |
| `auth` | §5.10 |
| `images` | §5.17 |
| `channels` | §5.11 |
| `rewind` / `fork` / `transcript` | §5.12 |
| `subagents` / `tasks` | §5.13 / §5.14 |
| `sideQuery` | §5.16 |
| `pendingRetraction` | `remove(id)`：从客户端队列删除（未发出才可删） |

### 5.10 凭据（`auth/`）

**来源顺序**（D7），每个 hub 在握手后、首个 thread 前决定一次：

1. **激活的渠道**（§5.11）有连接：hub 以渠道 provider 启动（`-c model_provider=…` 等覆盖 +
   令牌经 `env_key` 注入子进程环境）。不触碰 OpenAI 登录。
2. **内置 OAuth `openai-codex`**（`host.oauthCredential('openai-codex')` 有存储）且**路由为第一方**：
   `account/login/start{type:'chatgptAuthTokens', accessToken, chatgptAccountId, chatgptPlanType}`。
   - `chatgptAccountId`/`chatgptPlanType` 从访问令牌 JWT 载荷的 `https://api.openai.com/auth`
     声明读取（`chatgpt_account_id`、`chatgpt_plan_type`；F30）。只解 base64url 载荷，不验签
     （令牌由我们自己的存储给出）。解不出账户 id → 不注入，降级到 3，并在 `/login` 显示原因。
   - 刷新：hub 收到 `account/chatgptAuthTokens/refresh{reason, previousAccountId}` →
     `source.fresh({rejected: 当前令牌})`（compare-and-swap，见 `OAuthCredentialSource` 契约）
     → 应答 `{accessToken, chatgptAccountId, chatgptPlanType}`。必须在 **10 s 内**应答
     （F27），所以 `fresh()` 以 8 s `AbortSignal` 调用；失败 → `respondError(-32000,'refresh failed')`，
     并给会话一条带 `/login` 指引的 error notice。
   - 令牌材料只在 `external-tokens.ts` 与 rpc 写入之间流动：不进日志、事件、提示、fixture；
     调试日志对 `account/login/start` 的参数做脱敏（键名保留、值替换为 `***`）。
3. **用户自己的 Codex 凭据**：什么都不做，app-server 自己读 `$CODEX_HOME/auth.json`/钥匙串/
   `OPENAI_API_KEY`/config provider。
4. **都没有**（`account/read` → `account:null && requiresOpenaiAuth:true`）：会话照常打开，
   首个回合前给 notice「需要登录：/login」；`/login` 提供：内置 OAuth（打开 dsh-auth 的
   `openai-codex` 登录向导，成功后走 2）、`account/login/start{type:'chatgptDeviceCode'}`
   （设备码，显示 `verificationUrl` 与 `userCode`）、`{type:'apiKey'}`（输入框；**会写入用户的
   Codex 凭据存储**，提示文案写明）。

**第一方路由判定**（`auth/route.ts`，"只在第一方注入令牌"的唯一实现，借鉴 Claude 三次泄漏
教训）：在 hub 握手后调用 `config/read{includeLayers:false, cwd}`，满足**全部**条件才算第一方：
- `model_provider` 为空或 `openai`；
- `model_providers.openai`（若存在）未覆盖 `base_url`，且 `openai_base_url` / `chatgpt_base_url`
  未设置或为官方主机（`api.openai.com` / `chatgpt.com`，https）；
- 没有激活渠道；`OPENAI_BASE_URL` 环境变量未设置或为官方主机。

任一条件不满足或 `config/read` 失败 → 不注入（fail closed），环境原样透传。**C0 已验证**（V9）：
键路径为 `config.model_provider`、`config.model_providers.<id>.{base_url,env_key,wire_api,requires_openai_auth}`、
`config.openai_base_url`、`config.chatgpt_base_url`；自定义 provider 下外部令牌登录被接受但不生效
（无账户、无刷新请求）——路由判定仍保留作为纵深防御。

**C0 已验证**（V17）：`account/login/start{chatgptAuthTokens}` 不同步校验（约 30 ms 返回），但随即
用令牌做工作区路由发现；令牌无效时服务端立即发 `account/chatgptAuthTokens/refresh{reason:'unauthorized'}`
并发 `account/login/completed{success:false, error}`，不写 `auth.json`。以 `login/completed{success:false}`
判定失败并降级（只停止注入，不调 `account/logout`——那会动用户自己的登录）。

**`auth` 能力**：`oauthProvider:'openai-codex'`；`status()` 行：凭据来源（渠道名 / dsh-auth
ChatGPT 订阅 + planType / Codex 自己的登录 / API key / 未登录）、provider 主机名；
`reconnect()`：重新执行上面的选择（新令牌 → 再次 `account/login/start{chatgptAuthTokens}`，
app-server 支持运行中替换，F27 的 "Use account/login/start (chatgptAuthTokens) to update it"），
无需重启 hub。

**条款**：在第三方客户端里使用 ChatGPT 订阅令牌受 OpenAI 条款约束；`chatgptAuthTokens` 是
app-server 面向宿主应用的官方模式，但是否允许第三方 TUI 使用由维护者判断——文档与 README 写明。

### 5.11 渠道（`channels.ts`，复用 `/channel` 界面）

Codex 渠道 = 一个 OpenAI 兼容的 Responses API 端点（中转站）。存储
`~/.dsh-tui/backends/codex/channels.json`：

```json
{
  "active": "myrelay",
  "channels": [
    { "id": "myrelay", "name": "示例中转", "baseUrl": "https://relay.example.com/v1",
      "tokenRef": "CHANNEL_RELAY_EXAMPLE_COM_TOKEN", "wireApi": "responses",
      "env": {}, "models": { "gpt-6.1-sol": "gpt-6.1-sol" } }
  ]
}
```

- 令牌存 DSH 凭据库（`src/backends/shared/channel-tokens.ts`，D15），文件只存 `tokenRef`。
- **URL 校验**（**评审修订**）：保存与启动前都校验 `baseUrl`——只接受 `https:`（`http:` 仅限
  `localhost`/`127.0.0.1`），**拒绝**带 userinfo（`user:pass@`）、query string、fragment，或路径段
  像密钥（`sk-`/`key=` 前缀、≥24 位的随机串）的 URL；凭据只能走 `env_key` / `env_http_headers`。
  原因：`-c` 参数在本机进程列表（`ps`）里可见，**中转站主机名会对本机其他用户可见**——这一点写进
  用户文档。C2 评估一个更好的承载：把 provider 定义放进 `thread/start.config`（JSON-RPC，不进 argv）；
  前提是验证它是否随 thread 持久化、resume 时如何生效、官方 `codex` 打开该 thread 时的行为——任一项
  不理想就保持 `-c`。
- 启动覆盖：`-c model_provider="dshtui-<id>"`、`-c model_providers.dshtui-<id>.name="<name>"`、
  `.base_url="<baseUrl>"`、`.env_key="DSH_TUI_CODEX_CHANNEL_TOKEN"`、`.wire_api="<wireApi>"`；
  令牌只放进子进程环境变量 `DSH_TUI_CODEX_CHANNEL_TOKEN`。**C0 已验证**（V10）：`-c` 对
  `model_providers.<新 id>` 表的整表注入可用（`config/read` 可见，真实回合经该 provider 跑通）。
- `ChannelProfileView`：`models` 显示 exact 映射，`tiers` 为空；`connection{baseUrl, hasToken, envKeys, fingerprint}`。
- `importFromSettings()`：从 `config/read` 的 `model_providers` 里找出当前 `model_provider`
  的 `base_url`/`env_key`，令牌从对应环境变量读（存在才导入）。`peekSettingsImport()` 同源。
- 切换渠道 → hub 指纹变化 → 新 hub + `thread/resume`（会话不断，回合间进行）。

### 5.12 历史、目录与生命周期（`session/history.ts`、`catalog.ts`）

**`history()`**（回放种子，在 `subscribe` 前由 channel 调用并同步画出）：
1. `thread/resume{excludeTurns:true, initialTurnsPage:{limit:20, sortDirection:'desc', itemsView:'full'}}`
   已在 open 时完成；其响应带 `initialTurnsPage`/`turnsBackwardsCursor`（F19）。**C0 已验证**（V4）：
   `initialTurnsPage` 接受 `itemsView`，缺省 `summary` 会省略工具 item，带 `'full'` 返回全量——一次请求即可。
2. 取最近一页（默认 20 个回合）→ 反转为旧→新 → `translate/replay.ts` → `AgentEvent[]`。
3. 记下 backwards cursor 供"加载更早消息"。
4. 正在进行的回合（resume 时 thread `status.active`）：回放到最后，然后 live 接续；进行中的
   item 没有 completed 也照常显示（live 的 `item/*` 会补齐）。**C0 已验证**（V5）：rejoin 运行中的
   thread 会以同一 id 重发挂起的服务端请求（§5.8 去重）。

**`transcript` 能力**（"加载更早消息"，契约是同步有界）：
- 调用方（已核对）：`core/compose.ts` 的 `transcriptLoadOlder()` 同步调用
  `hasOlder()`/`older()`，返回值是插入的行数；返回 0 行**不会**收起"加载更早"入口
  （`olderHistory` 只看 `hasOlder()`）。
- 设计：**始终预取一页**。`history()` 完成后立即异步取下一页（`thread/turns/list{cursor: backwards, sortDirection:'desc', limit:20, itemsView:'full'}`，
  本地 sqlite，毫秒级）放进缓存；`older()` 同步交出缓存页（旧→新翻译好的事件）、推进游标并
  立刻预取再下一页。缓存未就绪（极少见）时 `older()` 返回 `[]`，入口仍在，用户再点即可。
- `hasOlder()`：缓存非空或游标非空。
- `record()`：返回已加载全部回合的回放事件（供折叠行复原）。
- 预取失败：调试日志，游标保留，下次 `older()` 时重试一次；连续失败 3 次后 `hasOlder()` 返回
  false 并 notice。

**目录 `SessionCatalog`**（`catalog.ts`，复用同一 hub）：

| 方法 | 实现 |
| --- | --- |
| `list({cwd, allProjects})` | `thread/list{cwd: allProjects ? undefined : cwd, limit:200, sortKey:'recency'?, archived:false}` 翻页至多 500 条 → `SessionSummary{backendId:'codex', sessionId:id, title: name ?? preview, cwd, updatedAt, model, …}`（字段按 `SessionSummary` 定义填，**实现前读** `channel-session.ts`） |
| `info(id)` | `thread/read{threadId, includeTurns:false}` |
| `preview(id, {limit})` | `thread/turns/list{threadId, sortDirection:'desc', limit, itemsView:'summary'}` → `PreviewEntry`（用户/助手文本） |
| `rename(id, title)` | `thread/name/set` |
| `delete(id)` | `thread/archive`（D13）；界面文案"归档"。`-32600`（活动的内部 worker）→ 本地化拒绝 |

目录在浏览器打开时需要 hub：首次 ≈0.5 s（显示"加载中"）。

**fork / rewind**：
- anchor = 用户消息 item id（`userMessage.id`）。翻译器维护 `anchor → turnId` 映射（回放与
  live 都登记）。
- `fork.fork(anchor?, title?)`：`thread/fork{threadId, lastTurnId: anchor 所在回合 ?? 不传}` →
  若给了 title 再 `thread/name/set` → 返回新 ref（不切换）。
- `rewind.rewind(anchor, mode)`：只支持 `conversation`。已核对 `core/sessions.ts` 的
  `rewindTo()`：对话回退期望一个**新会话**（"backend's fork cut just before that message"），
  像 resume 一样采用它并把所选消息交还输入框；返回同一会话 id 时核心什么都不刷新。所以：
  `thread/fork{threadId, lastTurnId: anchor 所在回合的**上一个**回合}` → 返回
  `{kind:'rewound', session: 新 ref}`（与 Claude 完全一致，原 thread 保留，可 `/resume` 回去）。
  anchor 在第一个回合时没有上一回合 → `thread/start`（同 cwd/设置）得到空 thread 作为结果。
  **不用** `thread/revert`（原地删除，与核心的采用语义不符，且不可撤销）。
  `files`/`both` → `{kind:'refused', reason:t('codex-rewind-files-unsupported')}`；`preview` 不声明。
- `/clear`：只清视图（核心已实现）。

**挂载账本**：`codex:<threadId>`（核心按 `formatSessionRef` 自动处理）。同一 thread 被官方
`codex` 同时打开时，Codex 自己的 `thread-writer-locks` 负责。**C0 已验证**（V15）：另一进程已加载该
thread 时 `thread/resume` 返回 `-32600`，message `thread <id> already has an active writer`，映射为
本地化错误。官方前端退出后 daemon 仍可能保留写入者；原生凭据遇到此冲突时，先经
`app-server proxy` 的 WebSocket 握手连接本地服务，再用 `thread/loaded/list` 与
`thread/read` 确认目标已加载且为 `idle`，随后沿用共享投影器的完整分页恢复路径。
活跃回合、托管凭据与显式渠道不走该分支；代理不可用则保留原错误。代理连接从不
安装托管令牌，也不启动、停止 daemon。真实验证脚本为 `verify-codex-daemon-offline.ts`。

**C0 观察（评审更正）**：`thread/fork.beforeTurnId`（排除该回合及之后）只存在于**实验**类型
（`generate-ts --experimental`），0.144.0 与 0.160.1 的稳定类型都只有 `lastTurnId`。rewind 坚持用
稳定的 `lastTurnId`（上一回合）+ 首回合 `thread/start` 的方案；`beforeTurnId` 不采用。

### 5.13 子代理（`session/subagents.ts`）

- 父 thread 的 `subAgentActivity{kind:'started', agentThreadId, agentPath}` →
  `subagent.start{agentId: agentThreadId, parentCallId: item.id, description: agentPath 末段 / nickname, background:false, depth: agentPath 段数-1, time}`；
  同时 `hub` 登记 `agentThreadId → 本会话`，子 thread 的通知进入本会话的 lane 翻译。
- 子 thread 通知 → lane 事件：与主 thread 同一翻译器（独立实例），所有事件带
  `parentCallId = 启动它的 subAgentActivity item id`（子代理卡片/面板复用 Claude 的 lane 显示路径）；
  `thread/tokenUsage/updated` → `subagent.progress{usage}`；子 thread `turn/completed` 不结束子代理。
- `subAgentActivity{kind:'interacted'}` → `subagent.progress`；`'interrupted'` →
  `subagent.end{status:'cancelled'}`；`'completed'` → `subagent.end{status:'completed', summary: 子 thread 最后一条 final_answer}`。
- `collabAgentToolCall`：卡片抑制（`presentation:{card:'subagent'}`），`wait` 期间工作行显示
  "等待子代理"；`spawnAgent`（若出现）只补充 `model`/`prompt` 到对应子代理。
- `subagents.interrupt(agentId)`：`turn/interrupt{threadId: agentId, turnId: 子 thread 活动回合}`。
- `subagents.history(agentId, window)`：`thread/turns/list{threadId: agentId, itemsView:'full', …}` 分页 →
  lane 事件；`parentAgentId` 来自 `thread/read` 的 `source.subAgent.thread_spawn.parent_thread_id`
  （父为主 thread 时 null）。按 [dsh-child-transcript.md](dsh-child-transcript.md) 的清单实现。
- 回放：`subAgentActivity` 在父历史里有，子 thread 内容不在父历史里 → 回放只建子代理行，正文
  在用户展开时按需 `history()` 读取。

### 5.14 后台终端 → 任务（`session/tasks.ts`，实验接口）

- Codex 的 unified exec 可在回合后保留进程（`commandExecution.processId`）。
  `thread/backgroundTerminals/list` 列出、`/terminate` 结束（实验，D4 退路：不支持则不声明
  `tasks`）。
- 映射：回合结束时仍存活的 processId → `task.start{taskId:processId, kind:'shell', command, callId:itemId, background:true}`；
  `command/exec/outputDelta`/`process/outputDelta` 若带对应 processId → `task.output`；
  `process/exited` → `task.end`。`tasks.stop(id)` → terminate；`readOutput` 用会话内缓存的尾部
  （最后 64 KiB）。
- **C0 已验证**（V14，源码）：后台终端 = unified exec 中超过 yield 仍存活的进程（由模型决定，上限 64），
  跨回合存活直到退出或 terminate/clean；回合结束后**没有**生命周期通知，只能轮询
  `thread/backgroundTerminals/list`。本节降为 C4 可选（不声明 `tasks`，除非 C4 评估轮询方案）。

### 5.15 目标（`session/goals.ts`）

- `thread/goal/updated{goal}` / `thread/goal/cleared` → `goal.change`（需 N6 的预算字段）：
  `phase` = `active|paused|blocked|complete`，`usageLimited`/`budgetLimited` → `blocked` +
  `blockedReason{code: status, message: 本地化}`；`budget = {tokensUsed, tokenBudget, timeUsedSeconds}`。
- `/goal` 命令（DSH 已有的界面）：经新的 `goals` 能力（N6）`set(objective, {tokenBudget?})` →
  `thread/goal/set`、`pause()`/`resume()` → `thread/goal/set{status}`、`clear()` → `thread/goal/clear`。
- 初始：`thread/goal/get` 于 open 后读取一次。

### 5.16 后端命令、skills、`/btw`、hooks（`session/commands.ts`、`side-query.ts`）

`commands.list()` 返回（D14）：

| 命令 | 执行（`submit` 内识别 `/<name> args`） |
| --- | --- |
| `/review [base <branch> \| commit <sha> \| <自定义说明>]` | `review/start{threadId, target, delivery:'inline'}`；无参数 = `uncommittedChanges` |
| `/diff` | 显示最近的 `turn/diff/updated` 聚合 diff（作为本地 diff 卡/`local-output` 行）；没有则 `gitDiffToRemote`（若可用）或提示 |
| `/plan [prompt]` | 切到 Plan 模式（同 `modes.set('plan')`）；带 prompt 时随即以 Plan 模式发出（官方 `/plan` 语义） |
| `/usage` | 以 `local-output` 行列出 `account/rateLimits/read` 的各窗口（已用 %、重置时间）与 credits |
| `/<skill-name> [args]` | `turn/start{input:[{type:'skill', name, path}, {type:'text', text: args}]}`（skill 的 path 来自 `skills/list`） |

- 与本地命令重名时本地优先（核心的既定规则）。**评审修订**：dsh-TUI 本地已有 `/init`（DSH 扩展的
  AGENTS.md 模板生成器，非 DSH 会话会被拒绝），所以 `/init` **不能**作为后端命令——它会被本地名字
  遮住，永远到不了后端。改由 N9 的 `init` 能力承接：Codex 的实现提交官方 `/init` 提示词（从
  `codex-rs/tui` 取原文并注明来源版本）。本地已有的名字见 `src/commands.ts` 的 `LOCAL_COMMANDS`，
  设计后端命令前先查重；完整对照见 §8.6。
- `/btw`（`sideQuery`）：`thread/fork{threadId, ephemeral:true}` → `turn/start{input, approvalPolicy:'never', sandboxPolicy: read-only, developerInstructions 附加"只回答，不使用工具"}` →
  收集 agentMessage delta 为 `onText` → 完成后 `thread/unsubscribe`；`signal` 中断 →
  `turn/interrupt`。**C0 已验证**（V12）：ephemeral fork（`path:null`）带原上下文可跑回合，不出现在
  `thread/list`、不写 rollout 文件。`/recap` 同路径（固定提示词）。
- hooks：`hook/started`/`hook/completed` → info notice（`key: hook:<run.id>`，完成时替换为
  "hook <eventName> 完成/失败（耗时）"）；`hookPrompt` item → `user.message{source:'injected', label:'hook'}`。

### 5.17 图片（`session/images.ts`）

- 声明 `images.limits`：`mediaTypes: image/png|jpeg|gif|webp`、`maxImageBytes: 20 MiB`、
  `maxImagesPerMessage: 20`、`maxMessageImageBytes: 50 MiB`、`maxImageDimension: 2048`、
  `maxImagePixels: 2048*2048`（Codex 自己会再缩放；数值 C0 对照 `resize_all_images` 实现微调）。
- 发送：`{type:'image', url:'data:<mime>;base64,<b64>'}`。不用 `localImage`：临时导出的剪贴板
  文件会被删除，data URL 随 thread 持久化，回放可还原。
- 回放：`userMessage.content` 里的 `image{url:data:…}` → ImageRef facade（惰性解码，同 Claude
  `images.ts` 的 facade 模式）；`localImage{path}` → 路径 facade（文件不存在时显示占位）。
- `imageView` item → 工具结果带路径图片；`imageGeneration` item → 助手图片（**C0 已验证**，V13
  类型：`status`、`revisedPrompt`、`result`（图片数据）、`savedPath?`、`failure`；有 `savedPath` 用路径
  facade，否则用 `result`）。

### 5.18 偏好（`prefs.ts`）

`~/.dsh-tui/backends/codex/prefs.json`（原子写，`src/backends/shared/atomic-file.ts`）：
`{ model?, effort?, mode?, lastSession?, recent: string[], colors: Record<threadId,string> }`。
`BackendSessionPrefs`（launch）同 Claude 语义。读失败视为空，绝不阻断启动。

### 5.19 `!cmd` 与官方 shell 回合

- dsh-TUI 的 `!cmd`（只本地显示）/`!!cmd`（输出作为 followup 进上下文）由核心
  `core/local-actions.ts` 统一实现，对所有后端语义一致，**不改**。
- 官方 TUI 用 `!` 产生的 `userShell` 回合（F17）出现在历史里时，按终端卡回放
  （标题前缀 `!`，turn origin `user`）。

---

## 6. 中立层改动（N1–N7）

每项都是后端无关、可独立测试的增量；DSH 与 Claude 行为不变（门禁证明）。

| # | 改动 | 文件 | 形状 | 期 |
| --- | --- | --- | --- | --- |
| N1 | 后端共享件目录 + 边界规则 | 新 `src/backends/shared/{atomic-file,channel-tokens}.ts`（从 `claude/` 移来，Claude 改 import）；`scripts/verify-adapter-boundary.ts`、`ADAPTER.md` 规则表 | `shared/` 不得 import `@*/` 厂商包与 `backends/<任何具体后端>/`；`backends/<a>/` 不得 import `backends/<b>/`（`shared/` 除外）；新增 `native.codex` 规则（`allowedIn: 'backends/codex/'`）。`ClaudeChannelTokens` → `ChannelTokenStore`（类型别名保留一期以减小 diff） | C0 |
| N2 | MCP elicitation ↔ 问卷的纯函数 | 新 `src/channel/elicitation.ts`（从 `claude/dialogs.ts` 抽出 form schema → `QuestionItemView[]`、答案 → `content`、校验与重问、URL 模式问题） | 输入为 MCP 规范形状（`requestedSchema`、`mode`、`url`），无厂商类型；Claude 改为调用它（`verify-claude-dialogs` 不变绿） | C2 |
| N3 | 问卷保密输入 | `src/agent/events.ts` `QuestionItemView.secret?: true`；`AskUserQuestionPanel` 自定义输入以 `•` 掩码显示；答案记录行显示 `••••` | 缺省行为不变 | C2 |
| N4 | 运行中工具的实时输出 | `events.ts` 新事件 `{ type:'tool.output'; callId; text; time; parentCallId? }`（追加片段）；共享投影器给工具行维护 `liveOutput`（有界尾部：最后 200 行 / 16 KiB，超出记 `liveOutputDropped` 计数）；`tool.result` 到达时清除；终端卡运行中渲染最后 5 行（dim，宽度按显示单元截断，超出时首行 `… N 行省略`），全屏模式 8 行 | DSH/Claude 翻译器不发此事件（`verify:agent-domain` 穷举里登记为"可选未用"）；投影器对未知 callId 忽略 | C2 |
| N5 | 带真实行号的 unified patch | `channel-view.ts` `ToolFileDiff` 改为联合：`{path, oldText, newText}` \| `{path, patch, change?: 'add'\|'delete'\|'update', movePath?}`；`SplitDiffView`（及 diff 卡）对 `patch` 分支用已导入的 `JsDiff.parsePatch`（缺文件头时补 `--- a/<path>\n+++ b/<path>\n`）按 hunk 渲染真实新旧行号；`(+N -M)` 统计从 hunk 计算 | 旧分支零改动；窄宽度/CJK/超长行走现有换行与截断辅助 | C2 |
| N6 | 目标预算 | `ChannelGoal.budget?: {tokensUsed, tokenBudget: number\|null, timeUsedSeconds}`；目标面板/状态行有 `budget` 时显示 `已用 12.3k / 50k tokens · 4m` 替代轮次；新能力 `goals?: { set(objective, {tokenBudget?}); pause(); resume(); clear() }`，核心 `/goal` 在会话无 `native.dsh` 时委托它 | DSH 目标不带 `budget`，显示不变 | C4 |
| N7 | 内核注册数据化 | `kernelPrefs.ts` `KERNEL_IDS` 加 `'codex'`、`KERNEL_INFO.codex = {labelKey:'kernel-label-codex', product:'codex-cli'}`、`kernelDisplayName`；`dsh-adapter/backends.ts` `BACKEND_LOADERS.codex`；安装能力改为按内核（`installable(id)`，Codex 不可一键安装，只给 hint）；`BackendDetection.loginInSession?: true`（为真时 `auth:'missing'` 仍可选，行内提示"启动后 /login"）；`plugin.ts` 中 `kernel: 'dsh' \| 'claude'` 改 `KernelBackendId`；配置 Schema 与 `--backend`/`DSH_TUI_BACKEND` 接受 `codex` | 现有两内核行为不变 | C1 |
| N8 | 用量与上下文占用的中立通道（**评审修订**） | **N8a** 新事件 `{ type:'usage'; turn; step?; usage: UsageDelta; time; model? }`：投影器只记账（tokens、费用分桶、`lastUsage`、回合账本），不建行、不改行，`/trace` 与导出不收录。取代 C1 评审修复里的 `assistant.message.usageOnly` 标志（R-D1）——"一条不是消息的消息"会让每个消费 `assistant.message` 的地方都得特判它；独立事件让不关心的消费者走默认分支自然忽略。**N8b** 投影器记住最近的 `context.usage{used,max}`，核心的上下文占用（`resolveContextOccupancy`）在没有 DSH 投影值时**优先**用它，其次才是计费样本 | DSH/Claude 都不发这两个事件（已核对三个翻译器），行为不变；`verify:agent-domain` 登记 | C2（第一项） |
| N9 | 可选的 `init` 能力（**评审修订**） | `SessionCapabilities.init?: { run(): Promise<void> }`；核心 `/init` 在会话没有 `native.dsh` 且声明了 `init` 时委托它，否则维持现状（DSH 扩展生成模板 / 明确不可用） | DSH 不变；Claude 可顺带声明（提交 CLI 的 `/init`），恢复目前被本地名字遮住的 `/init` | C2 |

可选（C4 打磨，评审后决定是否合入）：品牌 `codex`（`branding.ts` 的 `Brand` 加 `'codex'`，
`auto` 时 `backendId==='codex'` 选它；中性黑白配色 + `CODEX` 字标，无吉祥物），需跑 logo/主题
相关回归。

---

## 7. 翻译器规格（`translate/`）

### 7.1 统一映射，live 与回放同源

`translate/items.ts` 导出纯函数 `itemEvents(item: Rec, phase: 'started' | 'completed', ctx: ItemContext): AgentEvent[]`。
`live.ts` 在 `item/started`/`item/completed` 时调用它，并额外处理 delta；`replay.ts` 对
`thread/turns/list` 得到的每个 item 依次以 `started` + `completed` 调用它（无 delta）。两者共享
`ItemContext`（seq 计数、turn/step、attempt、anchor→turnId 表）。**任何映射只写在
`items.ts` 一处**；live≡replay 测试（§10.4）保证不分叉。

### 7.2 身份字段

| 字段 | Codex 映射 |
| --- | --- |
| `sessionId` | `threadId` |
| `seq` | 翻译器单调计数；回放结束后 live 从同一计数继续 |
| `turn` | 每个 `turn/started`（回放：每个 Turn）+1；原生 turn id 存 `turnIds[turn]` |
| `step` | 回合内每个新 attempt +1；工具 item 归属当前 step（无 attempt 时先开一个空 step） |
| `attemptId` | `${turnId}#${step}` |
| `anchor`（用户消息） | `userMessage.id`；登记 `anchor → turnId` |
| `anchor`（助手消息） | `attemptId` |
| `callId` | item `id`（`exec-…`、`call_…`） |
| `parentCallId` | 子代理 lane：启动它的 `subAgentActivity` item id |
| `agentId` | 子 thread id |
| `userMessageId`（turn.start） | 该回合首个 `userMessage` 的 `clientId`（live）/ item id（回放） |

### 7.3 attempt/step 算法（复用 Claude `translate/attempts.ts` 的模式）

一次"模型回复"= 一个 attempt，承载其思考与正文，结算为**一条** `canonical:true` 的
`assistant.message{blocks:[{type:'reasoning',text}, {type:'text',text}]}`（缺的块省略）。

1. `reasoning`/`agentMessage`/`plan` item **started**：若无打开的 attempt → `step.end`（若有）、
   `step+1`、`step.start`、`assistant.attempt.start{attemptId, turn, step, model}`。
2. 思考 delta（`item/reasoning/summaryTextDelta`，以及 `textDelta` 当用户开启原始推理时）→
   `assistant.delta{kind:'reasoning'}`；`summaryPartAdded` 在已有摘要文本后插入 `\n\n`。
   正文 delta（`item/agentMessage/delta`、`item/plan/delta`）→ `assistant.delta{kind:'text'}`。
   `index` 固定 0（reasoning）/1（text）。
3. `reasoning` **completed**：把 `summary.join('\n\n')`（无摘要时 `content.join('\n\n')`）记为
   attempt 的 reasoning 文本（以完成值为准，覆盖 delta 累积）；attempt 保持打开。
4. `agentMessage`/`plan` **completed**：记 text，**结算** attempt（`assistant.message` +
   `assistant.attempt.end{committed}`）。
5. 任何非助手 item（工具类、`contextCompaction`、`subAgentActivity`…）**started**：若有打开的
   attempt（只有思考没有正文）→ 结算它（reasoning-only 消息）。
6. `turn/completed`：结算打开的 attempt（`interrupted` 回合标 `interrupted:true` 与
   `attempt.end{aborted}`），`step.end`，`turn.end`。
7. `phase:'commentary'` 与 `final_answer` 同样渲染为助手正文（官方 TUI 亦然）；工作行**不**保留
   commentary 文本——正文已在转录里，再叙述一次就是同屏重复（用户验证轮 1 报告的重复缺陷）。
   Claude 的 `narrated` 之所以能上工作行，是因为它的 `⏵` 行会被 `stripNarration` 从转录剥掉，
   单一显示面；codex 的 commentary 是线程历史的一部分，归属转录。

### 7.4 item 映射表

| item `type` | started | completed |
| --- | --- | --- |
| `userMessage` | `turn.start`（若回合未开，`origin:'user'`）+ 认领 pending + `user.message{id: clientId ?? item id, anchor: item id, seq, turn, source:'user', text, blocks, images}`（**C1 实施修订**：文本 = 第一个 text 输入即用户键入的内容，其余 text 只进 `blocks`——channel 展开的 `@` 文件与选区不进气泡；无 text 时用 `mention` → `@<path>`、`skill` → `$<name>`；`<bash-stdout>` 包裹 → `source:'command-output'`；图片 → ImageRef（C3）） | — |
| `hookPrompt` | `user.message{source:'injected', label:'hook', text: fragments 拼接}` | — |
| `agentMessage` / `reasoning` / `plan` | §7.3 | §7.3；`plan` 完成且处于 plan 模式 → 计划评审（§5.8） |
| `commandExecution` | `tool.call{callId:id, name: source==='userShell' ? 'user_shell' : 'shell', argsJson: JSON.stringify({command, cwd}), presentation: presentation.ts}`；登记 open item | `tool.result{callId, isError: status!=='completed' \|\| (exitCode??0)!==0, text: aggregatedOutput ?? '', errorText: declined ? t('codex-declined') : undefined, presentation}`；`durationMs` 由投影器从时间差算或用 item 值 |
| `fileChange` | `tool.call{name:'apply_patch', presentation: diff 卡（N5）}` | `tool.result{isError: status 为 failed/declined, presentation: diff 卡}` |
| `mcpToolCall` | `tool.call{name:`mcp__${server}__${tool}`, argsJson, presentation:{card:'generic', title:`${server}.${tool}`}}` | `tool.result{content: result.content 里 text → text 块、image → ImageRef, structured: structuredContent, isError: !!error}` |
| `dynamicToolCall` | 同 mcp（`namespace.tool`） | `contentItems` → content |
| `webSearch` | `tool.call{name:'web_search', presentation:{card:'generic', title: query, displayKey:'tool-name-web_search'}}` | `tool.result{text: action 摘要}` |
| `imageView` | `tool.call{name:'view_image', presentation:{card:'generic', title: displayPath(path)}}` | `tool.result{images:[路径 facade]}` |
| `imageGeneration` | `tool.call{name:'image_generation'}` | `tool.result{images:[savedPath 优先，否则 result]}`（字段 C0 已验证，V13） |
| `sleep` | `tool.call{name:'sleep', generic}` | `tool.result` |
| `collabAgentToolCall` | `tool.call{presentation:{card:'subagent'}}`（抑制卡片） | `tool.result`（抑制） |
| `subAgentActivity` | §5.13 | — |
| `contextCompaction` | `compaction.start{trigger: 本地发起 compact ? 'manual' : 'auto', cancellable:false}` | `compaction.end{ok:true, contextReplaced:true}`（清理旧上下文分类估算；占用仍等后端的新读数） |
| `enteredReviewMode` | `notice{level:'info', text:t('codex-review-start',{review}), key:'review:'+id}` | — |
| `exitedReviewMode` | — | `assistant.message`（review 文本作为 markdown 正文，独立 attempt） |
| 其他未知 `type` | 调试日志 + `custom{nativeType:'codex/'+type, data:item}`（插件渲染器可接；默认不显示） | 同 |

`turn/completed` 时仍在 `openItems` 里的工具 item：`tool.result{isError:true, errorText:t('codex-interrupted')}`（F11）。
回放里不存在这些 item（中断的 item 不落历史），所以 live 比回放多一张"已中断"卡——这是
**登记的有意差异**（§10.4）。

### 7.5 通知映射表

| 通知 | 事件 |
| --- | --- |
| `turn/started` | 记下回合 id。**C1 实施修订**：`turn.start` 在回合的第一个 item 到达时发出（空回合在 `turn/completed` 时开合），origin 由第一个 item 推断（用户消息/`userShell` → user，其余 system）——live 与回放同一规则；运行态由 `thread/status/changed` 给出 |
| `turn/completed` | §7.3-6；`turn.end{reason}`：`completed` → completed；`interrupted` → interrupted；`failed` → `{kind:'error', message: error.message, category: codexErrorInfo 的 kebab 名}`；附 `usage`（本回合 `last` 累加） |
| `item/started` / `item/completed` | §7.4 |
| `item/agentMessage/delta`、`item/plan/delta`、`item/reasoning/*` | §7.3 |
| `item/commandExecution/outputDelta` | N4 `tool.output{callId:itemId, text: delta}`（会话内按 callId 合并，≤10 Hz 刷出） |
| `item/commandExecution/terminalInteraction` | `tool.output{text: '⏎ ' + stdin}`（可见的交互输入） |
| `item/fileChange/outputDelta` / `patchUpdated` | 忽略（`apply_patch_streaming_events` 默认关） |
| `item/mcpToolCall/progress` | `tool.progress{callId, elapsedMs}` + 工作行文本 |
| `turn/plan/updated` | `todo.write{items: plan.map(s=>({content:s.step, status: pending/in_progress/completed}))}`（官方默认不开此工具，F26） |
| `turn/diff/updated` | 不发事件；会话保存最近 diff 供 `/diff` |
| `thread/tokenUsage/updated` | 窗口变化时 `context.capacity`；`usage{turn, step: 当前 step, usage:{input: last.inputTokens − cachedInputTokens, cacheRead: cachedInputTokens, cacheWrite: cacheWriteInputTokens, output: last.outputTokens}, time, model}`（N8a，只记账）；`context.usage`（官方 12k 基线公式，§5.9，N8b）。**现状**：C1 用 `assistant.message.usageOnly`（施工日志 R-D1）承载用量，C2 第一项迁到 N8a 的独立事件。历史不含用量：回合汇总行是 live 独有（§10.4 登记差异） |
| `account/rateLimits/updated` | `rate-limit{windows:[primary, secondary].filter(Boolean).map(w=>({name: windowName(w.windowDurationMins), utilization: w.usedPercent/100, resetsAt: w.resetsAt*1000}))}`；`rateLimitReachedType` 非空 → warning notice |
| `thread/status/changed` | `session.status`（§5.6） |
| `thread/name/updated` | `session.title{title: threadName, source}` |
| `thread/settings/updated` | 与快照比较，变化的发 `model.changed{source:'settings'}` / `effort.changed` / `mode.changed` |
| `model/rerouted` | `model.changed{model:toModel, source:'fallback'}` + `notice{key:'reroute', text:t('codex-rerouted',{from,to,reason})}` |
| `error` | `willRetry` → `notice{level:'warning', key:'retry:'+turnId, text:t('codex-retrying',{message})}`（同 key 覆盖）；否则等 `turn/completed` |
| `warning`、`configWarning`、`deprecationNotice`、`guardianWarning` | `notice{level:'warning', key: method+':'+hash(message)}` |
| `serverRequest/resolved` | §5.8 |
| `item/autoApprovalReview/*`、`autoApprovalReview/strictReviewRequired` | info notice |
| `thread/goal/updated` / `cleared` | `goal.change`（§5.15） |
| `hook/started` / `completed` | §5.16 |
| `mcpServer/startupStatus/updated` | 刷新 MCP 状态缓存；失败状态 → warning notice（`key: mcp:<name>`） |
| `skills/changed` | 重新 `skills/list` → `commands.changed` |
| `account/updated`、`account/login/completed` | 刷新 auth 状态；登录失败 → error notice |
| `thread/compacted`（旧） | 若本回合已有 `contextCompaction` item 则忽略，否则 `compaction.end{ok:true, contextReplaced:true}` |
| `thread/closed`、`thread/archived`、`thread/deleted` | 当前 thread 被别处关闭/归档 → warning notice（会话保持，可继续） |
| `model/verification`、`modelProvider/authRecovery*`、`turn/moderationMetadata`、`model/safetyBuffering/updated` | 调试日志（C4 评估是否需要提示） |
| 其余（realtime、fs、process、windows*、remoteControl、fuzzy、plugin/app、externalAgentConfig、command/exec/*） | 忽略（已在 optOut 的不会到达） |

### 7.6 回放细节（`replay.ts`）

- 输入：旧→新的 `Turn[]`（`itemsView:'full'`）。每个 Turn：`turn.start`（origin 由首个 item 推断：
  `userMessage` → user；`commandExecution{source:'userShell'}` → user（标题 `!`）；
  `contextCompaction` → system）→ 逐 item `started`+`completed` → `turn.end{reason: turn.status}`
  （`inProgress` 的最后一回合不发 `turn.end`，交给 live）。
- 时间：`turn.startedAt`/`completedAt`（秒）×1000；item 无时间时用回合开始时间（投影器只用于
  显示）。
- `turn.error` → `turn.end{kind:'error'}` 并在其后放 error notice（与 live 一致）。
- 回放不产生 `permission.*`、`question.*`、`tool.output`、`tool.progress`、`rate-limit`。
- 结束后 `ItemContext` 的计数器交给 live 翻译器继续（与 Claude replay→live 续号一致）。

---

## 8. 显示规格（体验第一）

对照基准：官方 TUI 的快照测试（`codex-rs/tui/src/**/snapshots/*.snap`，调研材料里有）。
目标是**信息对等**，呈现用 dsh-TUI 现有组件与主题。所有文案 zh/en 双语进 `src/i18n.ts`
（键名前缀 `codex-`），按显示单元宽度截断（仓库宽度辅助函数），不按字符串长度。

### 8.1 命令（`commandExecution`）

- **命令解包**（`translate/commands.ts`）：匹配 `^(?:/usr)?/bin/(?:ba|z)?sh -lc (.+)$`，内层若被单引号
  包裹则去掉外层引号并把 `'"'"'` 还原为 `'`；PowerShell 包装（`powershell.exe -Command …`）同理；
  解不出时若 `commandActions.length === 1` 用其 `command`，否则用原文。标题取第一行；多行命令
  标题后加 `…`，完整命令在卡片详情里。
- **只读动作**（D12）：`commandActions` 全为 `read` → read 卡，标题 `读取 a.ts、b.ts`（`Read a.ts, b.ts`），
  正文 = 输出（即文件内容）；全为 `search` → search 形状不可用（无结构化匹配），用终端卡，
  标题 `搜索 <query>（<path>）`，`displayKey:'tool-name-grep'`；全为 `listFiles` → 终端卡，标题
  `列出 <path>`，`displayKey:'tool-name-glob'`；混合/unknown → 普通终端卡。
- **运行中**：标题 + 已用时间（现有）+ N4 的实时输出尾部（最后 5 行 dim）。
- **完成**：终端卡的 `output`/`exitCode`（现有）；`exit≠0` 走现有失败样式；`declined` 显示
  `已拒绝`（`codex-declined`）；中断收尾显示 `已中断`。
- `source:'userShell'`：标题前缀 `!`（与 dsh-TUI 的 `!cmd` 行视觉一致）。

### 8.2 文件改动（`fileChange`）

- 一个 item 一张 diff 卡，含全部 `changes`：`add` → `{oldText:null, newText:diff}`（F14 原文）；
  `delete` → `{oldText: diff, newText:''}`（**C0 已验证**，V13：delete 的 diff 是被删文件原文）；`update` →
  N5 `{patch: diff, change:'update', movePath}`。
- 标题：单文件 `编辑 <path>`/`新建 <path>`/`删除 <path>`；多文件 `编辑 N 个文件`，每个文件小标题带
  `(+a -b)`（与官方 "Edited 2 files (+6 -1)" 对等）。路径相对会话 cwd（复用 `displayPath`）。
- 审批挂起时卡片显示 diff（审批面板说明"Codex 想应用以下改动"），用户能先看后批。

### 8.3 助手与思考

- 正文 markdown 走现有渲染；`commentary` 与 `final_answer` 同样式（官方亦然）。
- 思考：Codex 默认只有**推理摘要**（`summary`），按现有思考行显示（折叠策略不变）；只有
  token 计数时用现有"只有计数"的思考行（`reasoningOutputTokens` 来自 tokenUsage）。

### 8.4 审批面板文案（与官方对齐，F28）

| 选项 | zh | en |
| --- | --- | --- |
| accept | 是，执行 | Yes, proceed |
| acceptWithExecpolicyAmendment | 是，以后以 `<prefix>` 开头的命令不再询问 | Yes, and don't ask again for commands that start with `<prefix>` |
| acceptForSession（命令） | 是，本会话内此命令不再询问 | Yes, and don't ask again for this command in this session |
| acceptForSession（文件） | 是，本会话内这些文件不再询问 | Yes, and don't ask again for these files |
| network amendment | 是，允许此主机（本会话） | Yes, and allow this host for this conversation |
| decline | 否，跳过它继续 | No, continue without running it |
| reject + 理由（cancel） | 否，并告诉 Codex 怎么做（输入理由） | No, and tell Codex what to do differently |

面板已有的"拒绝并附理由"输入（`feedback:true`）承担最后一项：无理由 → decline，有理由 → cancel+followup。

### 8.5 其他

- Plan 模式：状态栏模式标签用现有 `plan` 着色；计划以助手 markdown 显示，随后计划评审面板（§5.8）。
- 问卷：`Questions 1/1 answered` 记录行沿用现有问卷记录渲染；`secret` 问题答案掩码（N3）。
- 上下文条：按官方公式的 `used/max`（§5.9、N8b），与官方 TUI 同一时刻显示同一百分比；额度：`rate-limit` 视图沿用 Claude 的周额度警告样式（primary=5 小时窗口，
  secondary=周窗口，名称由 `windowDurationMins` 推断：300→`5h`，10080→`weekly`，其余 `<n>m`）。
- 压缩、子代理行、任务卡、目标面板、通知行：全部现有组件。
- 工作行：回合进行中且 30 s 无任何该 thread 通知 → 工作行追加 `等待模型响应…`；120 s → 一条
  warning notice「模型长时间无响应，可按 Esc 中断」（F29）。

### 8.6 斜杠命令对照（**评审新增**，官方 0.160.1 `slash_command.rs` 全量）

| 处理方式 | 官方命令 → dsh-TUI |
| --- | --- |
| 本地命令，经会话能力实现（同名或等价） | `/model`（+`/effort`）· `/permissions` → `/permission`（§5.9 四项）· `/new` · `/resume`（浏览器 Codex 标签，C3）· `/fork` · `/rename` · `/compact` · `/recap`、`/side`/`/btw` → `/recap`、`/btw`（sideQuery，C4）· `/goal`（N6，C4）· `/export` · `/status`（+`/context`）· `/mcp` · `/init`（N9）· `/agents`/`/multi-agents` → 子代理面板（C4）· `/mention` → 输入框 `@` · `/quit`/`/exit` |
| 本地命令，语义刻意不同 | `/clear`：dsh-TUI 只清视图（官方是清屏并开新会话；要新会话用 `/new`）· `/logout`：只登出 dsh-auth 的 `openai-codex`，**不调** `account/logout`（那会删掉用户自己的 Codex 登录）· `/skills`、`/hooks`：本地为 DSH 语义；Codex skills 以 `/<skill-name>` 进菜单，hooks 以通知行呈现 |
| 后端命令（§5.16） | `/review` · `/diff` · `/plan` · `/usage` · 各 skill |
| 由 dsh-TUI 自己的设置/交互承担，不转发 | `/theme` · `/statusline` · `/title` · `/vim` · `/keymap` · `/tui` · `/raw` · `/copy`（复制交互）· `/archive`（浏览器"归档"，D13）· `/warnings`（通知行） |
| 后期评估 | `/ps`、`/stop`（后台终端无生命周期通知，V14；C4 评估轮询后接 jobs 面板） |
| 不支持（非目标） | `/voice` · `/app`/`/apps` · `/plugins` · `/worktree` · `/daemon` · `/pets` · `/experimental` · `/memories` · `/import` · `/feedback` · `/rollout` · `/cd`/`/pwd` · `/debug-config` · `/elevate-sandbox` · `/auto-review` · `/delete`（只提供归档）· `/ide` · `/test-approval` |

实现者在 C2 用 `LOCAL_COMMANDS` 逐项核对上表（本地名字优先），差异写进施工日志。

---

## 9. 错误、恢复与边界

### 9.1 错误分类与提示

| 情况 | 处理 |
| --- | --- |
| `codexErrorInfo:'unauthorized'` / 401 类 | error notice + `/login` 指引；外部令牌模式下 app-server 会先发刷新请求（§5.10） |
| `usageLimitExceeded` / `rateLimitExceeded` | warning notice，含最近 `rateLimits` 的重置时间 |
| `contextWindowExceeded` | error notice 建议 `/compact` |
| `serverOverloaded` / `httpConnectionFailed` / `responseStream*` | `willRetry` 期间 retry notice（同 key 覆盖）；最终失败 → turn.end error |
| `activeTurnNotSteerable` | steer 降级 followup（§5.7） |
| `sandboxError` | error notice；Linux 且无 bubblewrap 时附安装提示 |
| `cyberPolicy` / `misalignmentPolicyViolation` | error notice 原文 |
| JSON-RPC `-32601`（方法不存在） | 对应能力关闭 + 一次 notice「当前 Codex 版本不支持 X，请升级」 |
| `-32600` / `-32602` | 本地化错误，调试日志附原文 |
| 请求超时 | 本地化错误；连接不断 |

### 9.2 连接丢失与恢复

1. hub 检测到临时断线 → 撤回挂起请求、取消旁问并提示重连；保留原生回合的工具卡、attempt 与已显示正文。
   断连不是原生执行失败，不合成 interrupted 结果；永久连接失败才结算未完成项。
2. 重启成功 → `thread/resume` 携带 full-items 初始页，沿原生 cursor 回补到已知回合边界（最多 50 页 /
   1000 回合）。按 item id 只补缺失的 started/completed 阶段，原工具卡与 partial 回复原位完成，已完成
   用户行、工具与计费不重复。仍 active 时先恢复 input 的活动 turn，再放开 followup；读取预算超出或
   cursor 循环则明确警告并保持只读，绝不假报恢复成功。
3. 重启 3 次失败 → error notice「Codex 进程无法启动：<stderr 末行>」，会话保持只读（submit 拒绝）。

### 9.3 其他边界

- **未知 item/通知/服务端请求**：§5.2/§7.4 处理；`/doctor` 显示本会话忽略的未知类型计数。
- **版本**：低于 `MIN_CODEX_VERSION` → `installed:false` + 升级提示；高于验证线 → drift 提示，照常运行。
- **并发**：两个 dsh-tui 驱动同一 thread 由挂载账本阻止；官方 `codex` 同时打开同一 thread 时以
  Codex 的写锁为准（错误映射 C0 已验证，V15：`-32600 … already has an active writer`）。
- **cwd**：thread 的 `cwd` 来自 Codex；resume 时与当前目录不同 → 沿用 thread 的 cwd 并 notice
  （与官方一致；**C0 已验证**：`thread/resume{cwd}` 覆盖生效，C3 可提供"在当前目录继续"）。
- **Windows**：`PATH` 上的 npm `codex.cmd` 包装解析到包内真正的 `codex.exe` 后直接启动（**评审
  修订**：经 `cmd.exe` 转发会破坏 `-c` 参数的引号）；路径大小写不敏感比较；不处理 Windows 沙箱安装。
- **渲染安静**：任何诊断只走 `logForDebugging`/`DSH_TUI_DEBUG`，绝不写 stdout。

---

## 10. 测试与验证

### 10.1 假 app-server（`scripts/lib/codex-fake-app-server.ts`）

- 实现与 `rpc/transport.ts` 相同的 `Transport` 接口，经 `CodexHubDeps.transportFactory` 注入，
  不起进程、不走网络。
- 能力：按方法名脚本化响应（含错误）；回放一段录制（§10.2）的服务端消息序列——自动把录制里的
  请求 id 映射到当前客户端发出的 id，把 `threadId` 替换为当前 thread；服务端请求（审批/问卷/
  刷新）发出后**等待**客户端应答再继续；可注入崩溃（模拟退出）、延迟、乱序（同一 thread 内保持
  顺序，跨 thread 交错）。
- 记录客户端发出的每条请求（供断言参数：`clientUserMessageId`、覆盖项、决策）。

### 10.2 fixtures

- `scripts/fixtures/codex/wire/*.jsonl`：C0 从调研录制搬入，**再次脱敏**：
  中转站主机名 → `relay.invalid`，临时路径 → `/TMP/...`，任何 `sk-`/Bearer/JWT 形状字符串 → 拒绝
  入库（`scripts/lib/codex-fixture-sanitize.mjs` 检查，CI 跑）。现有录制：
  `s1-approvals`（文件审批 decline + 一个卡死回合）、`s1b-command-approval`、
  `s2-steer-interrupt-diff`、`s3-lifecycle-p1/p2`、`s4-plan-question`、`s5-subagent`。
  C0 补录：错误/重试、MCP 调用、web search、图片输入、elicitation（需一个本地 MCP 测试服务器）、
  goal、review、后台终端（若可触发）。
- `scripts/fixtures/codex/goldens/*.json`：录制经翻译器+共享投影器后的行快照（与 Claude
  `verify-claude-translate` 同格式）。

### 10.3 回归脚本（全部假 app-server，登记进 `scripts/run-ci-group.mjs` 的 channel-ui 组）

| 脚本 | 覆盖 |
| --- | --- |
| `verify-codex-rpc` | 分帧、超长行、id 配对、超时、服务端请求挂起/应答/未知方法、close 拒绝挂起 |
| `verify-codex-hub` | 握手参数、optOut、按 thread 路由（含子 thread 归属父会话）、引用计数与空闲关闭、崩溃重启与 `connectionRestored`、指纹多实例 |
| `verify-codex-translate` | 每个 wire fixture → 事件 → 投影 golden；§7.3 attempt 算法的边界（只有思考、commentary+工具、多条消息、中断） |
| `verify-codex-live-replay` | §10.4 |
| `verify-codex-input` | 四种 placement、steer 降级、客户端队列 FIFO、cancel 回执（user/interrupt/switch）、`clientId` 认领、turn/start 失败回滚 |
| `verify-codex-approvals` | 三类审批全部选项与决策映射、reject+理由（cancel+followup）、`serverRequest/resolved` 外部结算、问卷（含 isOther/isSecret/autoResolution）、elicitation、计划评审三个分支、dispose 撤回 |
| `verify-codex-auth` | 路由判定矩阵（每个非第一方条件单独触发 fail closed）、`chatgptAuthTokens` 登录参数（JWT 声明解析）、刷新 CAS 与 8 s 预算、刷新失败提示；**哨兵令牌扫描**：所有调试输出、事件、notice 中不得出现令牌片段 |
| `verify-codex-controls` | models/effort/modes（循环排除 full-access）/compact/context/account/mcp/commands/rename/color/diagnostics |
| `verify-codex-lifecycle` | catalog（list/info/preview/rename/archive）、fork、rewind（fork+采用、首回合、files 拒绝）、加载更早（预取、空缓存、失败重试）、`codex:<id>` 挂载账本、`--resume` |
| `verify-codex-subagents` | lane 路由、start/progress/end、interrupt、history 分页 |
| `verify-codex-images` | data URL 发送、回放 facade、限制 |
| `verify-codex-chat` | Chat 级无头渲染（`renderToScreen`/xterm headless）：命令卡（运行中实时输出、完成、失败、中断）、读/搜卡、diff 卡（patch 行号）、审批面板（选项文案）、问卷、计划评审、Plan 模式标签、额度警告；inline 与 fullscreen、80 列与 40 列各一份 |
| `verify:codex-contract` | 进 `verify:build`：生成目录哈希 = `contract.ts` 记录；代码里处理的方法/通知/服务端请求名都在生成联合里；`package.json` 不含 codex npm 依赖 |
| 中立层 | `verify-tool-live-output`（N4 投影+节流+渲染）、`verify-diff-patch`（N5 行号/窄宽/CJK/超长行）、`verify-question-secret`（N3）、`verify-goal-budget`（N6）、`verify-kernel-catalog`（N7 三内核与 loginInSession）、`verify-usage-event`（N8a 只记账不改行、不进 trace/导出；N8b 占用读数优先级）、`verify-init-capability`（N9 委托与 DSH 不变） |
| **事件流不变量**（**评审新增**，所有后端） | `scripts/lib/agent-event-invariants.ts` + `verify-agent-event-invariants`：对任意 `AgentEvent[]` 断言——每个 `turn.start` 先于该回合的一切事件且成对 `turn.end`（回放最后一个进行中回合除外）；回合之间没有游离事件；每个 `tool.call` 都有 `tool.result`（或在其回合结束时被收尾）；每个 `assistant.attempt.start` 都闭合；`seq` 严格递增；`permission.request`/`question.request` 都被 settle；`pending.changed` 认领的 id 都曾入队。对 **DSH、Claude、Codex 的全部 fixture**（live 与回放两条路径）运行。C1 评审抓到的"幽灵回合"这类缺陷由它自动兜住 |
| 评审回归（C1） | `verify-codex-input`：强制收尾后迟到的 item/`turn/completed` 被丢弃、`now` 先于残留 steer；`verify-codex-approvals`：子 thread 审批路由到父会话（含多层与"子 thread 先于 `subAgentActivity` 到达"的乱序）、审批命令无损显示、`writeStdin`/网络/附加权限/异 cwd 字段 |

### 10.4 live≡replay 等价门禁

对每个 wire fixture：(a) live 路径翻译全部通知得到投影行；(b) 用录制末尾的 `thread/read`
结果走 replay 路径得到投影行；(c) 比较时忽略 `id`/时间，**允许的差异只有**：中断时 live 多出的
"已中断"工具卡（F11）、问卷答复记录（F23 不入历史）、`tool.output` 实时尾部（结果出来后应
已清除，所以终态应一致）、回合汇总行与 token 计数（**C1 实施修订**：历史不含用量）、live 通知
产生的提示行（重试、警告、状态）。任何其他差异即失败；登记的差异必须在 fixture 里真的出现。

### 10.5 必跑的既有门禁（每期）

`pnpm build`（含 verify:build 全部）、`pnpm verify:package`、`pnpm smoke`、CI 回归
（`repro-askpanel`、`verify-askpanel-layout`、`repro-toolcards` 及现在的 render-scroll 组）、
`scripts/run-ci-group.mjs` 全部组、`verify:projection-golden`（DSH 不动）、`verify-dsh-translate`、
`verify:agent-domain`、`verify:claude-contract`、全部 `verify-claude-*`。已知时序 flake：按
contributing 的规则单独重跑并在进度日志说明。

### 10.6 真实 Codex（不进 CI）

- `scripts/verify-codex-live.ts`（`DSH_TUI_CODEX_LIVE=1`）走正式 `codexBackend.open`。所有运行期 import
  前隔离 HOME / USERPROFILE / CODEX_HOME；只有外部 spawn 边界追加成本守卫的中转 `-c` 参数，stdin
  请求先经 `assertCheapRequest`，最多 3 个回合。凭据仅来自 `CODEX_TEST_BASE_URL` /
  `CODEX_TEST_API_KEY`，不写文件、不打印。未 opt-in 或凭据缺席明确 skipped，不算实测通过。
- `scripts/verify-codex-live-guard.ts` 是不收费的守卫门禁；`verify-codex-offline.ts` 只验证真实
  app-server 离线控制面，不发 `turn/start`，不取代真实登录与模型回合。

### 10.7 性能预算

- DSH-only 启动：不加载 `src/backends/codex/`（`verify:package` 的入口 smoke + 现有启动探针对比）。
- Codex 冷启动：hub 就绪后 100 ms 内首帧（history 已同步画出）。
- 单条通知翻译 ≤1 ms；delta 合帧走现有 `wake:'frame'` 节奏；`tool.output` ≤10 Hz/每个 call。
- 加载更早：点击到行出现 ≤50 ms（预取命中）。

---

## 11. 分期实施

同一分支 `feat/codex-native`，每期若干 checkpoint 提交；每期结束跑 §10.5 全部门禁并写进度日志。
期间不对外可见的半成品：C1 起 `codex` 才出现在内核列表里。

### C0 契约、脚手架与事实复核（无用户可见变化）——**已完成**（施工日志 C0）

1. `scripts/codex-protocol-sync.mjs --bin <codex>`：跑 `app-server generate-ts --experimental --out`
   到临时目录，复制进 `src/backends/codex/protocol/generated/`，写 `README.md`（来源版本、命令、
   勿手改），算目录摘要写入 `contract.ts`。
2. `src/backends/codex/{contract.ts, protocol/index.ts, narrow.ts}`；`verify:codex-contract` 进
   `verify:build`（`scripts/run-verify-build.mjs` 列表）。确认生成类型不触发 hygiene/编译告警
   （若触发，按现有生成文件的豁免方式处理，不改生成内容）。
3. N1：`src/backends/shared/` + 边界规则（含后端互不 import、`native.codex`）+ `ADAPTER.md` 规则表。
   纯移动，全部 Claude 门禁不变绿。
4. fixtures 搬运与脱敏检查脚本；假 app-server（§10.1）+ 自测。
5. `scripts/lib/codex-cheap-only.mjs`、`scripts/probes/codex-*.mjs`（从调研材料移入并套守卫）。
6. **执行 §12 的 C0 验证清单**（每项一个最小探针，live 总预算 ≤12 回合），结果（含决定）写进
   `docs/codex-backend-progress.md`，必要时修订本文对应段落（在本文里标"C0 已验证"）。
7. 新建 `docs/codex-backend-progress.md`（格式同 `agent-backend-progress.md`：协议、决策表、逐期记录）。

验收：`pnpm build` 全绿；假 app-server 自测通过；C0 清单每项有结论。

### C1 核心会话（能安全地用起来）——**已完成**（施工日志 C1 与"C1 评审修复"）

范围：`rpc/*`、`hub`、`binary`/`detect`、`backend`、`session/{session,state,input,approvals(命令/文件/权限/问卷),history(首页),prefs(最小)}`、
`translate/*`（§7 全部，N4/N5 之前 diff 卡用 old/new 降级：update 的 hunk 拆成 old/new 文本，
行号从 1 起——C2 换成 N5）、N7 内核注册、`/doctor` 行、i18n。权限档在用户既没在 dsh-tui 选过、
`config.toml` 也没设时用 `auto`（on-request + workspace-write，§5.5 的优先级），保证有审批面板兜底。

验收：§10.3 的 rpc/hub/translate/live-replay/input/approvals/chat（不含实时输出与 patch 行号）
通过；live 冒烟 ≤3 回合（文本、命令审批、文件改动）；DSH/Claude 门禁全绿。

### C2 显示对等与控制面（**实现完成**，验收边界见施工日志）

中立层 N2–N6 已实现并合入（施工日志 "Neutral layer N2–N6"），本期只做 Codex 侧接线与下列新增。

1. **评审遗留先行**：`closeAllCodexHubs()` 接入退出漏斗；hub 诊断广播给所有会话（§5.3）；N8
   （把 `usageOnly` 迁到独立 `usage` 事件 + 投影器采用 `context.usage` 占用读数）；事件流不变量
   检查器（§10.3）接入并跑全部后端的 fixture。
2. **接上中立层**：`tool.output`（≤10 Hz 合并）、diff 卡换成 N5 的 `patch`、`isSecret` → `secret`、
   elicitation 走 `src/channel/elicitation.ts`。
3. **控制面**：models/effort；modes（§5.9：Shift+Tab 只切 Plan，权限档走 `/permission`）与计划评审；
   compact；context（官方 12k 基线公式）；account；rate-limit；mcp；commands（`/review`、`/diff`、
   `/plan`、`/usage`、skills）；N9 `init`；bubblewrap 对话内提示；默认设置优先级（§5.5）。
4. **凭据与渠道**：`auth/*`（路由判定、外部令牌、`/login` 三种方式、哨兵令牌扫描）；`channels.ts`
   （复用 `/channel` 界面、URL 校验、评估 `thread/start.config` 承载 provider）；之后实测冒烟改走正式的
   `codexBackend.open` 路径。
5. **命令对照**：按 §8.6 逐项核对 `LOCAL_COMMANDS`，差异记施工日志。
6. **中立小改动**：打断行文案按绑定后端的名字（"What should Codex/Claude do instead?"），DSH 逐字节不变。
7. **补录 fixture**（只录本期需要的）：错误/重试、MCP 调用、web search、elicitation（本地最小 MCP
   测试服务器）、`/review`；`verify-codex-chat` 补全显示断言（实时尾部、patch 行号、`availableDecisions`
   审批文案、计划评审、Plan 标签、额度警告；inline/fullscreen × 80/40 列）。

验收：对应脚本与事件流不变量通过；live ≤10 回合（含补录；Plan 问答+计划评审、`/review`、模型/effort
切换、中转渠道）；CI 渲染回归全绿；手动（有终端时）inline/fullscreen/窄宽各走一遍命令卡与 diff 卡。

### C3 会话生命周期（**实现完成**）

范围：catalog + 会话浏览器 Codex 标签（`SourceTabs` 已有 Codex 文案，接上 catalog）、`--resume` 与
上次会话标记、挂载账本、fork、rewind（fork+采用）、加载更早（预取）、rename、color、图片输入与回放、
连接丢失恢复（§9.2）。

验收：`verify-codex-lifecycle`、`verify-codex-images`、hub 崩溃恢复用例通过；live ≤6 回合
（resume 后继续、fork、rewind、图片）；与官方 `codex resume` 互通手动核对一次。

### C4 进阶与收尾（**实现完成**）

范围：子代理（lane + history）、后台终端（若 C0 证实可触发）、目标（N6）、hooks、`/btw`
`/recap`、notices 审计（每种 notice 有 key 与双语文案）、可选品牌；文档：`docs/codex-backend.md`
（用户说明，中/英）、README/README_ZH 的 Codex 段、`agent-backend-design.md` 增加 Codex 章节与
身份表一列、`docs/architecture.md`/`docs/contributing.md` 的回归对照表、`AGENTS.md` 仓库布局一行。

验收：全部 §10 门禁；live ≤8 回合；独立评审（§13）无阻断项后开 PR（`.agents/skills/pr`，需
跟踪 issue）。

---

## 12. C0 验证清单（已完成）与风险

### 12.1 验证清单（每项：探针 → 结论 → 若不成立的退路；保留作升级 Codex 时的复核清单）

**C0 已验证**：全部 17 项的结论、证据与处理见 [codex-backend-progress.md](codex-backend-progress.md)
的 C0 条目（探针 `scripts/probes/codex-c0-verify.mjs`）；对应段落已就地修订并标注。

| # | 待验证 | 退路 |
| --- | --- | --- |
| V1 | app-server 在 stdin EOF 时退出 | 直接 SIGTERM |
| V2 | 在 Codex 终端内运行时会继承的父级环境变量清单 | 只删已确认的 |
| V3 | `codex resume` 选择器是否列出第三方 app-server 建的 thread（`source:"vscode"`），以及让它列出的参数 | 文档注明"用 `dsh-tui --backend codex --resume`" |
| V4 | `thread/resume.initialTurnsPage` 的 `itemsView` | 改用 `thread/turns/list{itemsView:'full'}` |
| V5 | resume 进行中 thread 时挂起审批是否重发 | 不重发则回放后提示"有未完成的审批，请重新发起" |
| V6 | 中断后已发出但未被采纳的 steer 是否保留到下一回合 | cancel 回执 `outcome:'unknown'`（已是默认） |
| V7 | `item/tool/requestUserInput` 的取消应答形状 | 以 `respondError` 取消 |
| V8 | 官方 `/permissions` 预设的准确组合与名称 | 以本文 §5.9 的四档为准 |
| V9 | `config/read` 中 provider/base URL 字段路径；外部令牌对自定义 provider 是否本就不生效 | 路由判定按实际字段写；无论结果都保留判定 |
| V10 | `-c model_providers.<新id>.*` 整表注入可用 | 渠道降级为只读显示 config 里的 provider |
| V11 | `thread/settings/update`（实验）可在空闲时改模型/effort/模式 | 只经下一次 `turn/start` 覆盖 |
| V12 | ephemeral fork 不落盘、不入 `thread/list` | `/btw` 不声明 |
| V13 | `fileChange` delete 的 `diff` 内容；`imageGeneration` 字段 | 按实际改 §8.2/§7.4 |
| V14 | 后台终端的触发方式与通知 | 不声明 `tasks` |
| V15 | 与官方 `codex` 同开一个 thread 时的错误形状 | 通用错误文案 |
| V16 | `MIN_CODEX_VERSION`（`thread/turns/list`、`collaborationMode`、`subAgentActivity` 出现的最早版本） | 取 0.160.0 |
| V17 | `chatgptAuthTokens` 登录在无网络时是否立即校验（用语法合法的假 JWT 离线试） | 登录失败即降级到用户自己的凭据并提示 |

### 12.2 风险

| 风险 | 缓解 |
| --- | --- |
| 协议快速演进（数周一个 minor，已有方法被删） | 版本线 + 契约门禁 + 方法不存在降级 + 翻译器忽略未知；升级流程 = 同步脚本 + 跑 fixtures + 复核 §2 |
| 实验字段（Plan 模式）变动 | D4 退路：不支持则 Plan 模式不出现在 modes |
| 中转站静默卡死 | §8.5 等待提示与 Esc 中断 |
| 订阅令牌条款 | §5.10 条款说明；维护者决定 |
| 与用户官方 `codex` 共享状态 | 只经 app-server 访问；不写 config；挂载账本 + Codex 写锁 |
| 显示回归（N4/N5 改到共享卡片） | CI 渲染回归 + 新增窄宽/CJK 用例 + 手动演练 |
| ChatGPT 订阅下第三方 `originator`（`clientInfo.name = 'dsh-tui'`，会进 User-Agent 与请求头）是否被 OpenAI 后端接受未知 | 有账号时首个实测就验证；**不得**伪装成官方客户端名（`codex_cli_rs`/`codex_vscode` 等）；被拒时只能在文档里说明该路径不可用，用户改用自己的 Codex 登录或 API key |
| 中转站主机名出现在进程参数里（`-c model_providers.*.base_url`），本机其他用户 `ps` 可见 | URL 校验拒绝带凭据的形状（§5.11）；用户文档写明；C2 评估改由 `thread/start.config` 承载 |
| 新的不变量/顺序类缺陷（C1 评审实际发现过幽灵回合） | 事件流不变量检查器（§10.3）跑全部后端 fixture；假 app-server 的乱序注入 |

---

## 13. 实施协议（给执行者）

- **工作区**：本仓库分支 `feat/codex-native`（任何机器）。不要碰别人的分支（例如空的
  `feat/codex-backend`）与 main。新机器的准备步骤见[交接文档](codex-backend-handoff.md) §3。
- **先读**：本文、`agent-backend-design.md`、`AGENTS.md`、`docs/contributing.md`、`ADAPTER.md`、
  `docs/dsh-child-transcript.md`，以及要复用/对照的 Claude 实现（`src/backends/claude/`）。
- **提交**：`git -c user.name=Chimney -c user.email=ccchimneyyy@gmail.com commit …`；只暂存显式路径；
  绝不提交 `lib/`；提交信息末尾按执行方的署名规范加 `Co-Authored-By` 行；
  不 push（维护者另行决定）；不运行破坏性 git 命令。
- **成本**：能自己做就自己做；需要并行时最多约 2 个子代理，各在独立工作树、范围互不重叠，**子代理
  不得再派子代理**（维护者明确要求）；实测只按 §10.6 的守卫与每期预算；能用假 app-server 证明的绝不用实测。
- **凭据**：实测凭据只来自执行机器上的 `CODEX_TEST_BASE_URL`/`CODEX_TEST_API_KEY` 环境变量，绝不
  打印、不写入任何文件/日志/fixture/提交；推送前扫描 diff（中转站主机名、`sk-`、Bearer、JWT 形状串）。
- **进度日志**：每个 checkpoint 在 `docs/codex-backend-progress.md` 追加：做了什么、门禁结果
  （命令与通过数）、偏离本文之处及理由、遗留项。
- **偏离**：本文与实测冲突时以实测为准，在进度日志记录并修订本文；涉及架构（§3 决策、§6 中立层
  形状）的偏离先在日志写明理由再做。
- **质量**：TypeScript 规范按 AGENTS.md（ESM、`.js` 后缀、`import type`、不引入 `any`、
  两空格/单引号/无分号）；终端宽度用显示单元；TUI 运行时不写 stdout。

---

## 附录 A：客户端请求使用表

| 方法 | 用途 | 期 |
| --- | --- | --- |
| `initialize` / `initialized` | 握手 | C1 |
| `thread/start` / `thread/resume` / `thread/fork` | 新建、恢复、fork/rewind/计划实施 | C1/C3 |
| `thread/unsubscribe` | 会话 dispose、side query 结束 | C1 |
| `thread/list` / `thread/read` / `thread/turns/list` | 目录、预览、回放、加载更早、子代理历史 | C1/C3 |
| `thread/name/set` / `thread/archive` | 改名、归档 | C3 |
| `thread/compact/start` | `/compact` | C2 |
| `thread/settings/update`（实验） | 空闲时改设置（V11） | C2 |
| `thread/goal/get\|set\|clear` | 目标 | C4 |
| `thread/backgroundTerminals/list\|terminate`（实验） | 任务 | C4 |
| `turn/start` / `turn/steer` / `turn/interrupt` | 输入与取消 | C1 |
| `review/start` | `/review` | C2 |
| `model/list` / `collaborationMode/list`（实验） / `permissionProfile/list` | 控制面 | C2 |
| `skills/list` | 命令菜单 | C2 |
| `mcpServerStatus/list` / `config/mcpServer/reload` | MCP | C2 |
| `config/read` | 路由判定、渠道导入 | C2 |
| `account/read` / `account/login/start\|cancel` / `account/logout` | 凭据 | C2 |
| `gitDiffToRemote` | `/diff` 兜底 | C2 |

**不使用**：`thread/revert`（见 §5.12）、`thread/rollback`（已删除）、`thread/shellCommand`
（`!` 由核心实现，§5.19）、`thread/queue/*`（D9）、`command/exec*`、`fs/*`、plugin/marketplace/app、
realtime、remoteControl、userVerification、windowsSandbox、externalAgentConfig、feedback。
