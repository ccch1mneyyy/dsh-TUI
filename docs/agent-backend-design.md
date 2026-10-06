# 多后端架构

[文档索引](README.md) · [架构与限制](architecture.md) · [Claude 后端用户说明](claude-backend.md)

dsh-TUI 的会话可以跑在两个后端上：DeepSeek Harness（默认，下称 DSH）和实验性的
Claude Agent 后端（经 Claude Agent SDK 驱动本机 `claude` CLI）。两者共用同一套
Channel、投影器与界面；后端差异只体现在翻译器和会话能力上。本文说明现在的结构、
各层规则、Claude 后端的实现要点、已知限制，以及接入新后端要做什么。

## 分层

```text
src/screens · src/components · src/ink          界面：只读 ChannelUi，不碰任何后端
        │ ChannelUi（src/adapter/ports/channel-ui.ts）
src/dsh-adapter/channel.ts                      Channel 入口
  ├ channel/core/        后端中立核心：每个会话都走它
  ├ src/channel/         共享投影器（AgentEvent → ChannelState）与中立 store
  └ channel/extensions.ts  DSH 扩展：只在会话带 native.dsh 时挂载
        │ AgentSession · AgentEvent · SessionCapabilities
src/agent/                                      Agent Domain：纯类型 + 小工具函数，无 I/O
        │
  ┌─────┴─────────────────────┐
src/dsh-adapter/backend/      src/backends/claude/
DSH 翻译器与会话               Claude 翻译器、会话、目录、凭据
  │                             │
@deepseek-ai/*（Cordis 服务）  @anthropic-ai/claude-agent-sdk
```

依赖方向：界面 → ports；channel → agent + ports + 宿主服务；后端 → agent + 各自厂商
SDK；agent 读取 ports 类型并使用中立 helper。目录与 import 规则由 `verify:boundary` 强制，规则表见
[ADAPTER.md](../ADAPTER.md)。

一个进程只跑一个后端，在启动时决定（`dsh-tui --backend`、配置行 `backend`、
`/kernel` 记住的选择）。`/kernel` 切换后端的方式是记住选择并重启进程。

## Agent Domain（`src/agent/`）

- `events.ts`：`AgentEvent` 联合类型，live 流与历史回放共用同一套词汇。覆盖会话
  （ready/title/color/reset/status）、回合与步、用户消息、待发队列、助手流
  （attempt/delta/message）、工具（call/result/progress）、审批与提问、子代理与后台
  任务、压缩、上下文、模型/effort/模式变化、命令列表、DSH 专有事实（goal、preset、
  system prompt、request header）、提示与限流，以及给插件渲染器的 `custom`。后端
  不支持的东西就不发事件，不发假事件。
- `session.ts`：`AgentSession` 句柄：`history()`（回放种子）、`subscribe()`、
  `submit(input, placement)`、`cancel(cause)`、`dispose()`。`placement` 有四种：
  `turn`（空闲时开回合）、`steer`（并入运行中的回合）、`followup`（回合结束后再跑）、
  `now`（打断并立即投递）。取消回执带 `outcome`：只有 `confirmed` 的 `stillQueued`
  才代表后端的真实队列；`unknown`/`failed` 给的是请求时的快照，Channel 不能据此认定
  队列已空。
- `capabilities.ts`：`SessionCapabilities`，每项都是可选的类型化对象（permissions、
  questions、models、effort、modes、compact、rewind、fork、subagents、tasks、
  transcript、mcp、sideQuery、rename、color、images、commands、context、account、
  auth、channels…）。缺席即不支持：Channel 对应的动作明确报 "当前后端不支持"，
  不做静默 no-op。
- `native.dsh`：只供 DSH specialist 使用的逃生舱，暴露 DSH 的 `agent`/`ctx`；
  只能在 `src/dsh-adapter/` 内读（`verify:boundary` 检查）。
- `backend.ts`、`refs.ts`、`presentation.ts`：后端注册契约、跨后端的会话标识
  `{backendId, sessionId}`、工具卡形态的中立描述（界面按 `presentation` 选卡片，
  不按工具名）。

身份字段在两个后端上的含义：

| 字段 | DSH | Claude |
| --- | --- | --- |
| `seq` | 会话日志的 seq（持久） | 翻译器单调计数；回放与续接后的 live 从同一处继续编号 |
| `anchor` | `String(seq)` | 消息 `uuid`（fork、rewind、文件检查点都用它） |
| `turn` / `step` | 原生 | 每次开回合 +1 / 回合内每个 `message_start` +1 |
| `attemptId` | 流帧的 `attemptId` | `message.id` |
| `callId` | `tool/call.callId` | `tool_use.id` |
| `parentCallId` | 无（子代理另有事件） | `parent_tool_use_id` |
| `agentId` | 子 Agent 的会话 id | `task_id` |

## Channel：核心加 DSH 扩展

`createChannel` 在一个 owner 事务里做三件事：`createCoreChannel` 建核心 →
会话带 `native.dsh` 时 `attachDshExtensions` → `start`。任何一步抛错都整体回滚
（`verify-channel-rollback`）。

- 核心（`src/dsh-adapter/channel/core/`）对所有会话一样：绑定、输入管线（FIFO、
  `@` 提及、图片、IDE 选区、`tui/input` 决策）、共享投影器与唯一的 transcript 写入
  路径、宿主接缝、git 分支、`/clear`、`!cmd`、`/new`、`/export`、`/doctor`，以及
  按会话能力委托的动作。非 DSH 会话的 `/resume`、`/fork`、双击 Esc 回退由
  `core/sessions.ts` 基于后端的离线会话目录与 `fork`/`rewind` 能力提供。
- 动作按层解析（`core/actions.ts`）：明确不可用 → 会话能力（每次调用时在当前绑定的
  会话上重新解析）→ 核心动作 → 扩展动作。
- DSH 扩展（`channel/extensions.ts`）只做接线，DSH specialist 内部不变：同步种子
  回放、子代理与任务投影、resume/agent view/rewind/fork、模型/preset/模式、recap、
  DSH 报告。

新增后端不需要写 channel 代码。

## 数据来源

| 事实 | 来源 | TUI 自己存什么 |
| --- | --- | --- |
| DSH 会话 | DSH 会话事件日志 | `~/.dsh-tui` 下既有的偏好与元数据 |
| Claude 会话 | CLI 写的 `~/.claude/projects/<cwd>/<id>.jsonl`，经 SDK 的读写 API 访问 | `~/.dsh-tui/backends/claude/`：`prefs.json`（`/model`、`/effort`、`/permission` 选择、上次会话、最近使用、`/color`）、置顶、`channels.json`；不写转录，不写 Claude 的设置文件 |
| 回放 | DSH：全量日志；Claude：`getSessionMessages`（压缩后的链路），"加载更早消息"另读原生 JSONL | 无 |
| 权限状态 | 后端（DSH：permission presets；Claude：CLI 的会话与设置规则） | 无 |
| 用量/费用 | 后端上报优先（Claude 的 `total_cost_usd`），DSH 为本地估算 | 无 |
| 后端选择 | `--backend` / 配置行 / `/kernel` 记忆 | `~/.dsh-tui/kernel.json` |

用户消息不在提交时乐观插入，等后端确认（DSH：日志事件；Claude：
`command_lifecycle` 的 `started`）后才落行。

## Claude 后端（`src/backends/claude/`）

### 依赖与版本

- 传输：Agent SDK 的 streaming-input `query()`，一个会话一个长寿命 query。会话目录
  （list/fork/rename/delete/读消息）用 SDK 根入口的会话 API。
- `@anthropic-ai/claude-agent-sdk` 是可选 peer 依赖（平台二进制很大，不让每个 DSH
  用户都装），代码里动态 `import()`。版本精确钉在 `contract.ts` 的
  `VALIDATED_SDK_VERSION`，CLI 的验证版本见 `VALIDATED_CLI_VERSIONS`；`package.json`、
  lockfile 与 `contract.ts` 是否一致由 `verify:claude-contract` 检查（在 `build` 里）。
  行为差异优先按 `system/init.capabilities` 判断，版本号只用来解释。
- 可执行文件（`process.ts`）：`CLAUDE_CODE_EXECUTABLE` → `PATH` 上能启动的 `claude`
  → SDK 自带二进制。子进程环境由 `process.env` 构造，并清掉父级 Claude Code 终端导出
  的会话变量（dsh-tui 可能就跑在那样的终端里）。子进程 stderr 只进调试日志和去重后的
  提示，不继承到终端。

### 启动选项

`options.ts` 的 `OPTION_POLICY` 对 SDK 的每个选项都写明处理方式（`satisfies
Record<keyof Options, …>`，SDK 增删选项时 `tsc` 会报错）。要点：

- 系统提示与工具用 `claude_code` preset，`settingSources` 为 user/project/local：
  项目的 `CLAUDE.md`、设置、hooks、MCP、插件都按 CLI 自己的方式加载。
- 起始权限模式总是显式传入（省略时 CLI 的默认值不稳定）。
- 打开流式分片、子代理正文转发、逐任务停止（中断回合不杀后台任务）、文件检查点
  （回退文件需要）。
- 审批回调 `canUseTool`、MCP 表单 `onElicitation`、模型拒答时的回退对话框
  `onUserDialog` 都由 TUI 接管。

### 回合与输入

- 回合以 `result` 结束。判定先看 `terminal_reason`（`aborted_*` 即中断），再看
  `subtype`：`priority:'now'` 打断的回合是 `subtype:'success'` 加
  `terminal_reason:'aborted_*'`。取消后 30 秒仍没有 `result` 时强制收尾并提示。
- 放置映射：`steer` → `priority:'next'`（下一个工具轮次后并入当前回合；没有后续工具
  轮次时等同 followup），`followup` → 运行中用 `priority:'later'`、空闲时普通发送，
  `now` → `priority:'now'`。
- 待发队列以 `command_lifecycle` 为准；中断回执 `still_queued` 用来校正暂存的队列。
- thinking 可能只有 token 计数没有正文，界面支持"只有计数"的思考行。

### 审批、提问与对话框

- `canUseTool` → `permission.request` → 共享的 `PermissionStore`（FIFO，一次一个）→
  审批面板。选项由后端生成：允许一次、始终允许（只在 CLI 给出建议时出现，标签写明
  CLI 会记住什么；持久化完全交给 CLI）、拒绝（可附理由）。
- `AskUserQuestion` 走问卷面板；`ExitPlanMode` 走计划评审面板。
- SDK 的 abort signal、会话 dispose 与切换都会撤回挂起的请求，不会让面板卡住。
- MCP elicitation：表单每个字段一题并按字段约束校验；URL 模式给出链接提示。表单与 URL
  问题的规则在后端中立的 `src/channel/elicitation.ts`，后端只负责挂起与应答。
- 拒答回退：只声明 `refusal_fallback_prompt` 一种对话框（重试回退模型或取消）。

### 子代理与后台任务

- 子代理消息带 `parent_tool_use_id`，翻译后进子代理卡片与面板，不进主转录。`Agent`
  调用先建卡，`task_started` 到达后补全。
- 后台 Bash 成为任务卡；输出只读取 CLI 报告的那个文件的末尾（最后 64 KiB，屏上时
  每秒至多一次，路径做了校验）。
- `background_tasks_changed` 是全量快照：从快照里消失却没有结束事件的任务或子代理
  标为"状态未知"。

### 会话生命周期

- 目录（`catalog.ts`）：`listSessions` 带 `includeProgrammatic: true`。SDK 创建的会话
  在 CLI 自己的 `/resume` 选择器里是隐藏的，所以 dsh-tui 建的会话要用
  `claude --resume <id>` 打开。
- 恢复：先读历史（`getSessionMessages` 加子代理转录）并在订阅前同步画出，再接 live；
  续接后的翻译器沿用回放的编号。上下文窗口无法从转录恢复，等首个 `result` 补上。
- 加载更早消息（`older-history.ts`、`transcript-file.ts`）：从原生 JSONL 沿压缩边界
  逐段回溯，只读；文件超过 64 MiB 拒读。
- `/fork` 写一份可恢复的副本，不切换。双击 Esc 回退：文件用 `rewindFiles`（先 dry-run
  预览），对话用 `forkSession(upToMessageId)` 后切到副本。
- `/clear` 只清视图。CLI 自己重置对话（退出计划模式时清空上下文）会换新的会话 id，
  核心清空行、子代理与任务并提示。
- 挂载账本以 `claude:<id>` 登记，两个 dsh-tui 不会同时驱动同一会话；同时用普通
  `claude --resume` 打开同一会话无法察觉。

### 凭据

顺序见 `auth.ts` 头部注释：dsh-auth 的 `anthropic` 订阅登录（以
OAuth token 注入子进程，并移除 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`）→ 用户环境里的
API key 或云厂商路由 → 本机 `claude login`。订阅令牌只在第一方路由上注入：任何来源
（进程环境、CLI 的全局配置文件、设置 `env`）把请求指向别的主机、走 Unix 套接字、
云厂商或网关、`apiKeyHelper`，或设置读不出来，都不读令牌、环境原样透传。注入时还经
SDK `settings` 选项把路由钉回 `https://api.anthropic.com`。CLI 拒绝令牌时刷新一次并以
同一会话重连。`/channel` 激活的渠道连接优先于订阅登录。

在第三方客户端里使用 claude.ai 订阅登录受 Anthropic 的条款约束，见 Agent SDK 文档
的说明。

### 已知限制

- 一个进程一个后端；切换后端要重启（`/kernel`）。
- 没有会话树（`/tree`）：SDK fork 不记录血缘。
- 侧栏的 workspace 与 trajectory 面板还没按后端过滤：Claude 会话下前者提示不支持，
  后者为空。
- 未实现：`/add-dir`、拒答对话框的"修改提问"选项、拒答后撤回已流出的行、
  elicitation 的 URL 自动打开浏览器、SDK 预热（`prewarm()`）。
- 托管（policy）设置在会话运行中改了路由时，要到下一次启动 CLI 才重新判定。
- 绕过 dsh-auth 文件锁写凭据的进程仍可能与令牌刷新交错。

## DSH 后端

`src/dsh-adapter/backend/translate.ts` 把 DSH 会话事件与流帧翻成 `AgentEvent`，
`backend/session.ts` 把 `Agent` 包成 `AgentSession`。拆分是纯重构：
`verify:projection-golden` 用录制的 DSH 日志（`scripts/fixtures/dsh/`）对比拆分前后的
投影结果，`verify-dsh-translate` 覆盖每类事件。唯一登记的有意差异：运行中已被窗口
上限折叠的工具卡收到结果时，只更新状态和预览，不再挂回完整结果。

## 接入新后端

1. 新建 `src/backends/<id>/`，厂商包只在这里 import；在 `verify-adapter-boundary.ts`
   登记对应的包与 `native.<id>` 规则。
2. 实现 `AgentBackend`（检测、`open`、可选的离线会话目录）与 `AgentSession`。
3. 写翻译器：把后端消息翻成 `AgentEvent`，live 与回放用同一套映射；不认识的消息
   忽略，不崩。
4. 按后端真实支持的东西声明 `SessionCapabilities`；没有的就不声明，界面会显示不可用。
5. 工具卡经 `presentation` 描述，不在界面里按工具名分支。
6. 子代理转录页按 [dsh-child-transcript.md](dsh-child-transcript.md) 的清单实现
   `history`。
7. 回归用假 SDK/假进程驱动（参考 `scripts/lib/claude-fake-sdk.ts`），翻译器用脱敏
   fixture 测；登记进 `scripts/run-ci-group.mjs`。

## 验证

| 范围 | 脚本 |
| --- | --- |
| 边界与领域 | `verify:boundary`、`verify:agent-domain`（共享投影器与各翻译器对事件联合类型穷举） |
| DSH 等价性 | `verify:projection-golden`、`verify-dsh-translate` |
| Channel | `verify-backend-channel`、`verify-backend-chat`、`verify-channel-composition`、`verify-channel-rollback`、`verify-permission-store`、`verify-approval-panel-options` |
| Claude 后端 | `verify:claude-contract`（在 `build` 里）与 `scripts/verify-claude-*`（假 SDK，在 CI 组里） |
| 真实 CLI | `verify:claude-live`、`verify:claude-headless`、`scripts/probes/*`：消耗真实用量，不进 CI；`scripts/lib/claude-haiku-only.mjs` 把它们钉在 haiku，环境或持久化选择指向其他模型时拒绝运行 |
