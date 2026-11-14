# DSH Agent Teams 支持设计（#1241）

DSH 的 Agent Teams 在 TUI 里的适配方案与已确认的事实。跟随版本线 `0.2.2-rc.3`；上游在 `0.2.2-rc.2` 把团队从实验性 bundle 改为 `dsh-base` 内置能力 + **按根会话保存的选择**，成员改用统一的具名子代理。TUI 只消费上游公开行为：不 import 团队包，投影值本地收窄，开关经 `agentTeams` 服务的方法调用。

两种上游形态**按形状探测**，不按版本门（与 [ADAPTER.md](../ADAPTER.md)「按形状探测而非版本门」一致）：

| 形态 | 出现版本 | `agentTeam` wire | 成员来源 | 开关 |
| --- | --- | --- | --- | --- |
| **roster**（旧宿主） | `0.2.2-rc.1` 及更早 | `{ members, tasks, failure? }` | wire 里的 durable 名单 | 实验性 bundle 的启停（`/plugin enable\|disable`） |
| **switch**（rc.2+） | `0.2.2-rc.2` 起 | `{ enabled, tasks, failure? }`，**无 members** | 根会话的 `subagentCatalog` 投影（payload v3 带 `name`）+ 现有子代理行 | 会话级 `agentTeams.setEnabled(rootAgent, enabled)` |

旧宿主路径全部保留：rc.1 与更早的宿主仍在支持线内，它们的服务、投影和工具形态不变。

## 上游模型（`0.2.2-rc.2` 起）

- **内置且默认关。** `dsh-base` 的 `cordis.patch.yml` 新挂 `agent-team`（`@deepseek-ai/dsh-agent-team`，`maxTasks: 256`）与 `tool-agent-team`（`@deepseek-ai/dsh-tool-agent-team`）；新根会话默认不启用团队，选择保存在根会话（`team/mode` 事件）并跨重启保持。旧实验包（`dsh-experimental-agent-team-profile` / `-agent-team` / `-tool-agent-team`）rc.2 未发布，且被 `dsh-official-bundles` 列入 `RETIRED_BUNDLES`，profile 加载时会被移除。
- **投影只带选择与任务板。** `agentTeam`（key 不变，stateVersion 7）的 wire 是 `{ enabled: boolean, tasks: TeamTaskView[], failure?: string }`，`members` 与 `TeamMemberProjection` 被删除；官方 Web 面板只显示任务，成员浏览交给子代理界面。
- **成员 = 根会话当前的具名子代理。** `subagent` / `subagent_fork` 支持可选 `name`（同级唯一，根是 `lead`，后代是 `reviewer/checker` 这样的路径名）；`subagentCatalog` 投影 payload v3 的每行带 `name`。团队开关作用于整棵子代理树，子代理就是成员。
- **工具面统一。** `spawn_teammate` 与团队版 `send_message` / `list_agents` / `interrupt_agent` 移除；创建、消息、中断、列举改用标准具名子代理工具，只保留四个 `team_task_*` 任务工具与 `team:policy` 提示段。任务结果把 `ownerId` 映射为 `owner`（名字）。
- **关闭不毁数据。** 关闭团队保留子代理与任务：已受理的任务操作跑完，排队操作在开始时检查当前模式；子代理照常运行，只是任务工具与团队提示段不再出现。
- **工具结果形状（TUI 卡片跟进）**：`send_message({agent,message}) → {messageId}`、`interrupt_agent({agent}) → {accepted}`、`list_agents() → [{name,status,description?}]`（status: `running`/`inactive`/`corrupt`/`unsupported`/`unavailable`）、`wait_agent() → {timedOut}`（`noProgress` 删除）、`team_task_*` 结果带 `owner`（名字）与 `team_task_list` 的 `nextCursor`。

## TUI 读侧

- **`src/dsh-adapter/team-roster.ts`** 是唯一读侧：`agentTeam` 与 `subagentCatalog` 两个投影各用 `session-projection-store.ts` 的小工厂，绑定同一个「根会话」（`teamRootOf` 沿 `parentSession`/`origin: 'subagent'` 向上走到树根，支持多层子代理）。`asTeamView` 按 wire 形状收窄：
  - roster：成员、任务、`failure` 来自 wire；隐式单人团队（只有 lead、无任务、无 failure）不算团队。
  - switch：`enabled`/`tasks`/`failure` 来自 wire；members 由 lead + catalog 里带 `name` 的直接子代理合成（`label` 作为成员描述，未命名历史子代理不进名单）；`enabled=false` 但仍有任务时返回只读视图，都没有则返回 `undefined`（界面退回子代理视图）。
  - 成员来源只依赖投影 wire，不调用 `ctx.subagents.*`（rc.2 删除了 `listChildren` 等旧方法；子代理数据层由 `channel/subagent-projection.ts` 自己形状探测）。
- **`TeamView` 端口类型**（`src/adapter/ports/channel-view.ts`）带 `mode: 'roster' | 'switch'` 与 `enabled: boolean`：旧 wire 是 `roster`/恒开；switch 宿主可以有关闭但任务板仍可见的根。`TeamMember` 增加可选 `description`（创建 label）。`SubagentState` / `SubagentRow` 增加可选 `name`（catalog v3 的模型可见名，由子代理数据层写入）。
- **store 跟服务与投影走。** 服务卸载（bundle 关停或 HMR）时收窄为「无团队」；`agentTeam`/`subagentCatalog` 任一变化都重算成员；`plugin-manager/changed` 与 `internal/service` 两个信号都触发重读。channel 经 `team` getter 暴露，UI 只依赖端口类型。
- **UI 合成**（`src/components/teamRoster.ts` + `SubagentDashboard.tsx`）：成员与子代理行按 `id`（子代理的 `agentId` = child Session id）连接；不在名单里的子代理（workflow/ralph/未命名多层）列在「其他子代理」；`switch` 且关闭时显示「团队已关闭、任务板只读」提示，仍保留成员列表与任务板。

## 开关

- **rc.2 起：会话级选择。** `/team on|off` 经形状探测调用 `ctx.agentTeams.setEnabled(rootAgent, enabled)`（服务同时有 `setEnabled`/`isEnabled` 才算 switch 宿主）。根 Agent 由 `plugin.ts` 接线（`rootAgent: () => liveDshAgent()`）；team-mode 内部用 `ctx.get('subagents').rootOf` 走到树根（上游拒绝从后代改选择）。取不到 Agent 时降级为只读状态（`/team` 仍报服务和成员）。
- **关闭时的确认改用子代理计数。** rc.2 关闭团队**不停止**子代理，所以不再有旧的「停止 teammate」确认；但运行中的子代理会失去任务工具，因此 `/team off` 在 `active + unseen > 0` 时先提示「N 个子代理在运行，确认请 `/team off force`」，不写选择。计数来自绑定会话的子代理行（不再有团队 wire 名单）。
- **旧宿主：bundle 路径保留。** 服务没有 `setEnabled` 时 `/team on|off` 仍回答迁移提示（`/plugin enable|disable <legacy bundle>`、CLI 路线或「安装不自带团队包」），`/team status` 报 bundle/服务/成员。`/plugin disable` 命中旧实验 bundle 时仍按 `team-active` 询问（该确认只对旧 bundle 生效；rc.2 不再列出它）。
- **`/team` 可见性**（`channel/extensions.ts`）：按 `agentTeams` 服务挂载与否决定 Help/`/` 补全里是否出现；rc.2 的 `dsh-base` 始终挂服务，所以这一行始终在。服务缺失时手敲 `/team` 仍是本地命令，不会被当文本发给模型。
- **委派工具取舍（旧宿主）**：`teamReplacedToolDeny` / `filterTeamReplacedTools` 以 `spawn_teammate` 是否存在判定旧团队开启，从而在旧宿主上隐藏 `subagent`/`subagent_fork`。rc.2 没有 `spawn_teammate`，该谓词自然为空操作；标准 `subagent`/`subagent_fork` 本身就是委派面，不需要也不应再被 deny。保留函数只为旧宿主。

## 工具卡片（`src/dsh-adapter/team-tools.ts`）

上游团队工具没有 presenter，plain 卡片会显示大写工具名与原始 JSON；这些视图把已知形状折成一行，未知形状（错误文本、变化的形状）退回普通卡片。presenter 由工具自己注册时永远优先。

| 工具 | 旧团队 copy（≤rc.1） | rc.2 标准控件 |
| --- | --- | --- |
| `send_message` 调用 | `target` | `agent`（名字或 Session id） |
| `send_message` 结果 | `{sent:true}`（0.2.0 另有邮箱 `status`） | `{messageId}` → 卡片显示 `sent` |
| `interrupt_agent` 调用/结果 | `target` / `{previousStatus}` | `agent` / `{accepted}` |
| `list_agents` 行 | `{target, status, ...}` | `{name, status, description?}`（路径名如 `reviewer/checker`） |
| `wait_agent` 结果 | `{timedOut, noProgress?}` | `{timedOut}` |
| `team_task_*` 任务 | `ownerName` | `owner`（名字）；`team_task_list` 可带 `nextCursor` |

旧调用记录（`agent_id` 参数的旧版控件）保持普通卡片，不误判成团队卡。历史日志里的 `spawn_teammate` 调用仍归子代理行（`isSubagentToolName` 保留）；rc.2 移除了该工具，因此旧日志里「在写成员前被拒」的 spawn 不再补错误卡。

## 兼容（0.2.0 日志）

0.2.0 形态集中在 `src/dsh-adapter/compat/agent-team-0.2.0.ts`，由读取方在入口归一化一次，每个兼容点带 `compat(dsh 0.2.0, log)` 标记：

| 兼容点 | 归一化 | 调用处 |
| --- | --- | --- |
| 邮箱来源的团队消息（首块 `Team message <id> from <name>:`） | `teamMailboxAsRelay` | `backend/translate.ts`、`channel/subagent-projection.ts` |
| teammate 首条消息的 `<system-reminder>You are teammate …` 身份块 | `withoutTeammateReminder` | `backend/translate.ts`、`agent-view.ts` |
| `send_message` 结果 `{messageId, status:'accepted'\|'queued'}` | `legacySendMessageStatus` | `team-tools.ts` |

回归：`scripts/verify-agent-teams-compat-0.2.0.ts`（每条只断言「0.2.0 输入与对应 0.2.1 输入产出相同」）。

## 历史日志与降级

- rc.2 的 `agentTeam` 投影只 fold `team/mode` 与 `team/task`，不再 fold `team/member`。rc.1 及更早的团队日志没有 `team/mode`，因此历史团队会话在 rc.2 上是「未启用、无 wire 成员」：任务板仍在（`enabled` 缺省按关闭，任务可见则显示只读任务板），成员改由该会话的子代理树合成；两者都没有时退回普通子代理视图，不提示「团队可用」。
- 旧日志里成功的 spawn 仍显示为子代理行；写成员前失败、或成员写入后失败的 spawn 只留子代理行/名单痕迹，不再生成工具卡（见上）。
- rc.2 的 catalog v3 使旧 DSH 打不开含具名子代理的会话（持久化 acknowledgement），发布说明里提示共享会话库的进程一起升级。

## 已知限制

- roster 宿主（≤rc.1）的开关仍是 profile 级（bundle 启停），不能按会话开关；rc.2 起才是会话级选择。
- 旧宿主上的开关入口仍是 `/plugin enable|disable`；`/team on|off` 只给迁移提示。
- 成员名单取自根会话 `subagentCatalog` 的直接子代理；更深的具名子代理在仪表盘里作为「其他子代理」出现，不展开为团队行（`list_agents` 的 `reviewer/checker` 路径名只出现在工具卡里）。
- 任务板显示全部非删除任务，不分页；`team_task_list` 的 `nextCursor` 不上卡片（当前页看起来像全部）。
- 关闭团队前的确认用 `/team off force` 二次输入实现（TUI 没有为命令加交互浮层），确认文案说明子代理不会被停止。
- `/export` 只导出人类输入：团队消息不在导出的 .md 里，由它引发的回复缺少因由。
- teammate 页里的团队消息由通用 agent-message 流显示，发送方显示为会话关系而不是成员名。
- 上游限制：teammate 共用工作目录、团队只在单进程内、任务负责人不会自动释放。

## 验证

- `scripts/verify-agent-teams.ts`：双 wire 收窄（roster/switch）、catalog 成员合成、树根解析（含多层）、组合根 store（旧 wire 与 rc.2 switch、catalog 迟到、服务增删、禁用只读板）、团队消息气泡、工具卡新旧形状。
- `scripts/verify-agent-teams-compat-0.2.0.ts`：0.2.0 日志兼容。
- `scripts/verify-team-mode.ts`：旧宿主 bundle 路由与可见性、旧 `team-active` 确认、rc.2 `/team on|off`（setEnabled/根 Agent/运行中子代理确认/force/失败/取不到 Agent 的降级）。
- `scripts/verify-team-dashboard.tsx`：仪表盘成员/任务/失败横幅/窄宽度合并。
- `scripts/verify-plugin-manager-chat.tsx`：`/plugin list` 不再推销退役的 Agent Teams bundle。
