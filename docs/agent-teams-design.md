# DSH Agent Teams 支持设计（#1241）

DSH 的实验性 Agent Teams（`@deepseek-ai/dsh-experimental-*` 四个包）在 TUI 里的适配方案与已确认的事实。跟随版本线 `0.2.1-rc.5`；下面「已实测」两节是在 `0.2.0-rc.2` 上实测的，0.2.1 的差异见「0.2.1 版本线」。只消费上游公开行为：不 import 团队包，投影值本地收窄，开启由上游 bundle 负责。

## 已实测的事实

以下事实来自真实的 `0.2.0-rc.2` 团队服务与工具，模型为脚本化桩。投影与记录形态在 0.2.1 不变；`scripts/verify-agent-teams.ts` 的消息与结果 fixture 用 0.2.1 形态，0.2.0 形态只在兼容回归里（见「兼容（0.2.0）」）。

- **每个根会话都是隐式 Lead。** 服务挂上后，任何根 Agent 的 `tryMembership` 都返回 `{ role: 'lead', name: 'lead' }`，`agentTeam` 投影在没有任何团队事件时就是 `{ members: [lead], tasks: [] }`。因此「存在团队」= 至少一个 teammate、或有任务、或有 `failure`，而不是成员非空。
- **团队工具装在每个根 Agent 上，与 preset 无关。** `tool-agent-team` 在 `agent/created` 时按成员身份装到 Agent 自己的 `ctx`，所以团队模式是 profile 级的。Agent 作用域会遮蔽祖先层同名工具，所以团队的 `send_message` 等会盖住旧版控件；但 `subagent` / `subagent_fork` 名字不同，会和 `spawn_teammate` 并存。上述遮蔽结论只实测了「根层全局 vs Agent 作用域」，没有实测「preset 常驻作用域 vs Agent 作用域」。
- **teammate 就是 continuable 子代理。** `subagent/start` 的 `id` = 成员 `id` = teammate 的 sessionId；事件本身不带描述，teammate 会话的 `subagent/descriptor.label` 是 `spawn_teammate` 的 `description`。teammate 会话头是 `origin: 'subagent'`、`parentSession: <Lead>`、`delegationDepth: 1`。
- **团队消息的形态（0.2.0，0.2.1 起见下节）。** 落在目标会话中，是一条 `user/message`，`source = { kind: 'team-message', teamId, messageId, senderId, senderName }`；`content[0]` 恰为 `Team message <messageId> from <senderName>:`，后面跟发送者的原始内容块。实录的方向是 teammate→Lead；Lead→teammate 走宿主专用的 Steer 路径，未实录，按同一 `TeamMessageSource` 类型假定形态相同。Lead 另外会收到 `subagent-settled` 通知（已有的注入上下文，不显示）。
- **团队服务经 `ctx.root` 注册投影。** `TeamService` 调 `ctx.root.sessionProjections.register`，在 dsh-tui 宿主的 root 守卫下会被拒（`root.effect is unavailable from a plugin activation`），团队服务与工具都不激活。`host-access.ts` 只对这一调用放行 host 能力，注册照旧落在 root fiber 上，由调用方自己的 disposer 按调用方的顺序注销；插件没注销的，在它的 fiber 卸载完成（所有 effect、含异步清理都结束）后释放；root 对其他调用仍然关闭（`verify-plugin-lifecycle.ts` 覆盖）。不能改挂到调用方 fiber：`TeamService` 在外层 effect 里注册、在其异步 disposer 的 `finally` 里注销，挂到调用方 fiber 的注册会成为同级 effect，Cordis 卸载时并发清理同级 effect，`disposeRuntime()` 还没读完团队投影 key 就没了，抛错后跳过释放 teammate。上面的实测没有经过这道守卫。
- **状态语义不同。** teammate 回合结束时 `subagent/end stopReason: completed`，但名单里 `phase` 仍是 `active`，上游合成的状态是 `inactive`（发消息即可唤醒）。

### 0.2.1 版本线（读包源码，未在真实进程中实测）

对照 `0.2.0-rc.2` 与 `0.2.1-alpha.5` 发布包的差异（`0.2.1-rc.2` 至 `0.2.1-rc.5` 的三个团队包与 `0.2.1-alpha.5` 相比只改了版本号与依赖版本，以下同样适用）：

- **团队消息改走通用 relay。** 不再有团队邮箱：`send_message` 直接把消息 steer 进目标（Lead 用 `root.steer`，teammate 走宿主子代理 prompt），`user/message` 的来源是 `{ kind: 'agent-message', form: 'relay', senderSessionId }`，`content[0]` 恰为 `Team message from <name>:`。`team/message/queued` / `delivered` 只在旧日志里出现，`maxPendingMessagesPerMember` 已移除。
- **relay 不是团队专属。** 0.2.1 的旧版 `send_message`（`subagents.sendMessage`）也写 relay 来源，所以只有整块等于团队前缀的首块才把 relay 认作团队消息（`teamMessageOf`）；发送者名取自前缀。没有拿名单核对 `senderSessionId`：翻译器手里没有名单。
- **`send_message` 结果** 是 `{ sent: true }`（不再有 `messageId` / `status`）；旧版控件的结果是 `{ messageId }`，按记录形态仍能区分。
- **teammate 身份** 改由 `team:identity` 系统提示上下文提供，首条消息不再带 `<system-reminder>You are teammate …` 前缀块。
- **`interrupt_agent` 可关**：工具包新增 `interrupt` 配置（默认开）。
- 团队投影（`agentTeam`）与任务、成员记录的形态不变。

渲染的归属（每个界面只有一个渲染者，两种形态同一套）：上游 main 已经把 relay 折进通用的 agent-message 流（`subagent-projection.ts` 的 `agentMessages`，子代理页的 `agent-message` 叶子与 messages 页），但不进主 transcript。团队消息因此分两处显示：接收方主 transcript 里是 `✉ <发送者>` 气泡（`teamMessageOf`）；teammate 自己的页面交给 agent-message 流。0.2.0 的邮箱来源先由 compat 改写成它在 0.2.1 里变成的 relay（见「兼容（0.2.0）」），旧日志与新版本走同一条路径。

### 运行时启停（实测，0.2.0-rc.2）

以下在 `dsh --profile dsh-tui` 进程内实测，`0.2.0-rc.2`，真实模型。工具集来自 `/debug-prompt` 快照。

- **会话内 `/plugin disable|enable @deepseek-ai/dsh-experimental-agent-team-profile` 已经可以热应用。** dsh-base 在 `dsh --profile` 启动时挂上 `plugin-manager` 和 `hmr`，团队 bundle 可管理，结果是「已应用」，不需要重启。走的是 `pluginManager.setBundleEnabled`：写回 profile `package.json` 的 `dsh.profile.bundles`（持久，重启后保持），再 `reconcileProfilePatches` 热应用整套 patch。
- **存活的 Agent 跟着增减工具。** `tool-agent-team` 的 `apply` 启动时给 `agents.list()` 补装，退出时卸掉全部（含 `team:policy` 提示词段）。开头的 system 消息保持不变（缓存前缀），之后追加一条新的 system 消息和一条 `developer` 消息（`tool-removal` / `tool-addition` 逐个列出工具），模型看得到变化。开→关→开往返验证过。
- **同名工具由 Agent 作用域遮蔽 preset 作用域**（`standard` preset）。preset 里保留旧版四行时，assembly 里 `send_message`、`list_agents`、`interrupt_agent`、`wait_agent` 各只出现一次，执行走团队实现（`list_agents` 返回团队名单）；`subagent`、`subagent_fork` 和 `spawn_teammate` 并存。关掉团队后，同名工具在同一会话里退回旧版实现（`list_agents` 返回 `(no subagents)`）。
- **（修复前）TUI 的 preset 调整是关掉以后旧版委派回不来的原因。** 第一阶段的 `registerBundledPresets` 禁用了 preset 的旧版行，关掉团队后存活会话里不仅团队工具没了，`subagent`、`subagent_fork` 和四个控制工具也都没有，只剩 workflow。上游 preset 注册表重新注册时只退役旧 generation，已 join 的 Agent 留在旧 generation 上；只有首轮前的 `select` 会 rebind。所以重新注册 preset 救不回已有会话。
- **关闭时正在运行的 teammate 不会被停掉。** 回合中途它的团队工具被拆掉（它的日志里同样有 `tool-removal`），回合照常跑完；之后它就是 Lead 的普通 continuable 子代理，Lead 收到 settled 通知后用旧版 `list_agents` 看到它是 `[inactive]`，可以用旧版 `send_message` 继续驱动。
- **（修复前）TUI 的团队 store 在关掉以后残留。** 投影定义注销时不发 `onChanged`，`channel.team` 保留最后一个值，仪表盘仍是团队模式。
- **热应用期间 profile 的 `cordis.yml` 被写成合成后的整棵树**（上游 loader 的写回），下次启动时复位成 `[]`；重启后行为正常。

## 第一阶段（本 PR）

- **开启**：`/plugin list` 会列出安装自带的 `@deepseek-ai/dsh-experimental-agent-team-profile`，用户用 `/plugin enable <bundle>` 把它加进 TUI profile（需要显式安装时也可 `dsh plugin add` 同版本包）。第一阶段曾在 `registerBundledPresets` 里按 profile 行禁用 preset 的旧版委派行；这一做法已由「开关机制」的按 assembly 取舍取代。不改 `cordis.patch.yml`，也不新增依赖。
- **投影**：`src/dsh-adapter/session-projection-store.ts` 是「单 key + 本地收窄 + 绑定时 seed + 只留当前会话」的小工厂；`team-roster.ts` 是它的第一个使用者，teammate 会话经 `parentSession` 读 Lead 的值。经 channel 的 `team` getter 暴露，UI 只依赖端口类型 `TeamView`。
- **消息气泡**：translate 按身份剔除前缀块，映射到中立来源 `team-message`（带 `sender`）；投影器产出 `label: 'team-message'` 的 user 行，不计入回退目标和最近提问；`TeamMessageBubble` 渲染。识别由 `team-tools.ts` 的 `teamMessageOf` 完成，只认 0.2.1 relay（`verify-agent-teams.ts`）。teammate 自己的页面（子代理 transcript 的历史页与实时尾巴）不另做团队叶子，见上节「渲染的归属」（`verify-dsh-child-transcript.ts` T11）。
- **工具卡片**：`spawn_teammate` 并入子代理行；上游在写入 `team/member` 之前就拒绝的创建（重名、名字非法、成员数上限、非 Lead 调用、服务正在销毁、写入前取消）没有名单行承载，翻译器在错误结果到达时补出它本来的普通卡片（成功时不补）；成员写入之后的失败（启动失败、用户中断、provisioning 冲突）由名单上 `phase: 'failed'` 的成员连同 `error` 承载，不补卡片。翻译器按 spawn 参数里的 `name` 匹配随后的 `team/member`，同一步并行发出两个同名 spawn 时分不清是哪一个（只先清掉第一个）；其余工具在上游没有 presenter 时由 `team-tools.ts` 给出单行卡片。三个与旧版控件同名的工具，调用按参数区分（团队用 `target`，旧版用 `agent_id`），结果按记录形态区分。

## 第二阶段

- **统一 agent 视图（已完成）**：Ctrl+A 仪表盘与 agents 侧栏收到 `channel.team` 时进入团队模式（`SubagentDashboard` 的 `team` prop）。合并在纯模块 `src/components/teamRoster.ts`：子代理行的 `agentId` 就是 `subagent/start` 的 id，也就是成员 `id`，按它连接；不是成员的子代理行（workflow / ralph）列在「其他子代理」下，原样渲染。teammate 卡片沿用 `SubagentCard`，成员名代替 description，团队状态代替 continuable 标记。状态合成规则如下：`phase: 'failed'` 优先（附 `error`）；`provisioning` 显示准备中；`active` 时子代理行 running/starting 才算运行中，跑完、失败或还没有行都是空闲（发消息即可唤醒），不显示成已完成；上一轮失败时卡片下补一行错误（侧栏 badge 也算这一行）。只在名单里、还没有子代理行的成员显示为单行，能聚焦但不能进详情或 Agent View。任务板只读：状态、subject、`ownerName`（窄宽度省略）、阻塞（pending 且未 `ready`）、写入范围警告数。`failure` 显示为错误横幅。侧栏 badge 把 `phase: 'failed'` 的成员计入未读错误。`verify-team-dashboard.tsx` 覆盖合并、两种形态、窄宽度与宽字符成员名。
- **状态栏摘要（后续）**：`team 2/3 running · tasks 3/7`，按宽度逐级降级；本 PR 未实现。
- **进入 teammate 会话**：先进只读详情，再「进入会话」（Lead 留在后台）。agent-view、session-tree 和心跳都按 `origin === 'subagent'` 排除了 teammate，需要为团队成员开例外。0.2.0 的 teammate 首条消息以 `source: user` 落盘，内含 `<system-reminder>You are teammate …</system-reminder>` 前缀块（气泡只显示首个文本块，于是只看得到这段身份说明）；渲染时由 compat 去掉（见「兼容（0.2.0）」），0.2.1 起没有这个前缀块。

## 开关机制（已实现）

团队模式在会话里随开随关；关掉以后委派能力完整退回旧版，界面退出团队模式。

- **作用域：profile 级，持久。** 开关就是团队 bundle 的启停，复用上游 `pluginManager.setBundleEnabled` + `hmr`，不另造开关状态，也不碰 loader entry；`/plugin`、`dsh plugin` 与 Web 插件管理看到的是同一个状态。会话级开关 TUI 单方面做不到：每个根 Agent 都是隐式 Lead，装工具只看 membership；在 assembly 过滤只能藏起团队独有的工具，同名工具被 Agent 作用域遮蔽，旧版回不来。列为上游需求（本节末）。
- **`/team [status]`**（`src/dsh-adapter/team-mode.ts`）：只报告，不再启停。命令按 `agentTeams` 服务挂载与否动态出现：服务在时帮助与 `/` 补全里才有这一行，`extensions.ts` 订阅 `internal/service` 重新发布 `commandList`（与团队 store 同一个信号）；服务不在时手敲 `/team` 仍被识别为本地命令，不会当普通文本发给模型，并按这次启动能走的路线作答：bundle 未选中时返回 `team-cmd-not-enabled`（给出 `/plugin enable <bundle>`），profile 已选中却没有服务时返回 `team-cmd-pending-on`（重启后生效或激活失败，不给一条只会是 no-op 的开启命令）；没有 profile 插件服务时改给 `dsh plugin --profile … add` 的 CLI 路线，安装不自带该包时说明先换 DSH 版本线。status 只在服务挂载时运行，报告 bundle 是否选中、bundle 已关闭而服务仍在跑时提示重启，以及本会话 teammate 数与运行数；没有 `pluginManager`（独立入口的轻量 profile、旧宿主）时只报服务状态和一句原因。开关改用 `/plugin enable|disable <bundle>`：与 `/plugin` 同一条生命周期 flow、同一个确认浮层、同一个 `team-active` 确认（关闭时有成员在运行）。`/team on|off` 不再写入，输入会得到迁移提示。
- **委派工具按 assembly 取舍**（缺口 1）：`registerBundledPresets` 不再改 preset，旧版行一律保留；`system-prompt/assemble`（与 `filterMinimalPresetTools` 同一处，先于它）里 `filterTeamReplacedTools`：有 `spawn_teammate` 就去掉 `subagent`、`subagent_fork`，没有就原样不动。四个同名控制工具交给作用域遮蔽（已实测）。
  - 判定看工具是否真的在，所以开关当下的存活会话、之后的新会话、服务激活失败、团队行在 `group: true` 组里或启动后才挂上、profile 自己声明的 preset，都自动正确。
  - 工具变更通知跟过滤一致：agent-loop 用 `assembly.tools`（已过 `system-prompt/assemble`）对已记录的请求头 diff 出 `tool-addition` / `tool-removal`（读过 `dsh-agent-loop` 源码）。
  - 行为变化：团队开着时，workflow 或 ralph 拉起的非成员子代理没有 `spawn_teammate`，保留 `subagent`（原先的 preset 调整对它们一律禁用）。它们不是团队成员，旧版委派是它们唯一可用的委派；递归深度仍由上游 `delegationDepth` 约束。
- **团队 store 跟着服务走**（缺口 2）：收到 `plugin-manager/changed`，或 `internal/service` 报告 `agentTeams` 变化（HMR 应用的 CLI/手改、迟到或恢复的激活不经 manager 事件）时，对绑定的会话 `reseed()`；读不到快照（无注册表、Lead 不在线、读取失败）时对已持有的值重新收窄；收窄时 `agentTeams` 服务不在即视为没有团队（不依赖投影注销与事件的先后）。关掉后仪表盘和侧栏退回子代理视图；重新打开后从 Lead 日志恢复（服务构造时 `scheduleRecovery`），重新 seed 读回。
- **关闭时有成员在运行**（缺口 3）：不拒绝，但会停止它们。团队服务卸载时 `disposeRuntime()` 对仍驻留的 teammate 调 `subagents.drainChildren`（读上游源码，未在真实进程中实测；先前「实测为平滑降级」是注册顺序 bug 让这一步抛错跳过的结果，见上文 `host-access.ts`）。disable 解析到团队 bundle、且本会话有 running / provisioning 的 teammate，或从 teammate 会话看不到运行状态的其他 teammate（`teamMemberCounts` 的 `unseen`，按「可能在运行」计）时，流程先问 `team-active`；由 `/plugin disable` 承担（`/team` 已不承担开关）。只数当前绑定会话的成员：开关作用于整个 profile，同进程后台会话的 teammate 不在确认里（它们同样会被停止）。
- **边界与版本线**：`pluginManager`、assembly 过滤与 store 都在 `src/dsh-adapter/`；Chat 只经类型调用入口，成员计数用 `teamDashboardModel`。只依赖上游公开面（`setBundleEnabled` / `listBundles`、`plugin-manager/changed`、`internal/service`、`system-prompt/assemble`、作用域遮蔽），不读 `TeamService` 内部。
- **验证**：`verify-team-mode.ts`（过滤谓词、store 清空与恢复、`/team status` 与可见性 helper、隐藏时提示、`team-active` 确认，含 `/plugin disable` 路径）；`verify-team-command-visibility.ts`（help/`/` 补全里的 `/team` 跟随 `agentTeams` 服务的挂载与卸载）；`verify-bundled-presets.mjs` 断言团队行不改 preset；`verify-agent-teams.ts` 的根 store 用例补上服务。
- **实现后实测**（副本 profile，真实模型，在注册顺序修复之前；当时开关入口还是 `/team on|off`，现在的等价入口是 `/plugin enable|disable`）：`/team` status、开启（trust 确认）、关闭（有成员运行时的 `team-active` 确认）；关掉后存活会话的请求换回 `subagent` / `subagent_fork`，`developer` 消息逐个列出增减；仪表盘退回子代理视图；重新打开后名单与任务板（含进行中的任务和负责人）恢复。当时运行中的 teammate 显示为可继续子代理，是 bug 跳过释放的结果；修复后关闭会停止它们，这一点尚未在真实 profile 下重测。`/team` 现在只读，且按服务挂载出现。
- **未实测**：关闭时正处于 provisioning 的成员；liangshen（include）下的遮蔽；被藏起的工具在执行时是否仍可调用（即使能，结果也合法）。
- **会话级开关（上游需求）**：需要上游提供按根会话 opt-in 的 membership，比如 `agentTeams.enable(root)` 写一条会话事件、`tryMembership` 只认已 opt-in 的根。那时 `/plugin enable` 仍表示 profile 可用，另需一个会话级入口（可以回到 `/team on` 或新命令）。

## 兼容（0.2.0）

主路径只认 0.2.1 形态；0.2.0 形态全部集中在 `src/dsh-adapter/compat/agent-team-0.2.0.ts`，由读取方在入口归一化一次。每个兼容点带可 grep 的标记 `compat(dsh 0.2.0, <类别>)`，淘汰时 `grep -rn "compat(dsh 0.2.0"` 即完整清单。

类别决定淘汰时机：`host` 只在仍支持 0.2.0 宿主时需要；`log` 读 0.2.0 时期落盘的会话日志，0.2.1 宿主恢复旧会话时照样用到，不随宿主线淘汰，要单独决定何时放弃读旧日志。目前的兼容点都是 `log`：

| 兼容点 | 归一化 | 调用处 |
| --- | --- | --- |
| 邮箱来源的团队消息（`{kind:'team-message', senderId, senderName}`，首块 `Team message <id> from <name>:`） | `teamMailboxAsRelay`：改写成 relay 来源与 `Team message from <name>:` 首块；首块不按身份匹配时保留为正文 | `backend/translate.ts`（主 transcript 与子代理 transcript 页）、`channel/subagent-projection.ts` 两处（agent-message 流） |
| teammate 首条消息开头的 `<system-reminder>You are teammate "<name>". …` 身份块（0.2.1 改由系统提示上下文提供） | `withoutTeammateReminder`：按 0.2.0 模板整块逐字匹配才去掉，只作用于读取方见到的第一条 `source: user` 消息（translator 每次 replay / reset 重新计数；子代理 transcript 分页与 `history()` 之后的 live translator 从日志中途读起，会把各自见到的第一条当首条，只有人把模板原文单独成块再接其他块粘进那一条时才会误剪） | `backend/translate.ts`、`agent-view.ts`（首条 prompt）；会话预览（`sessions/digest.ts`）与 recap 目前读不到 teammate 会话，第二阶段打开时接入 |
| `send_message` 结果 `{messageId, status:'accepted'\|'queued'}` | `legacySendMessageStatus` | `team-tools.ts` 的 `resultLine` |

回归：`scripts/verify-agent-teams-compat-0.2.0.ts`，每条只断言「0.2.0 输入与对应 0.2.1 输入产出相同」。主回归不含 0.2.0 形态。

淘汰步骤：删除 compat 模块与上述调用、删除兼容回归及其 `run-ci-group.mjs` / `docs/contributing*.md` 登记、删除本节。

## 已知限制

- 开关是 profile 级的，不能按会话开关；没有 profile 插件服务或 `hmr` 的启动要 `dsh plugin` 加重启。
- 安装命令必须钉到版本线：团队包对 DSH 的 peer 是精确版本，npm 的 `latest`（`0.1.5-alpha.2`，团队投影没有 `wire` 视图，`channel.team` 读不到）和 `next` 都不在这条线上。团队包与 DSH 同步发版，提示里的版本取正在运行的 DSH 版本，但只限团队支持线（`0.2.1-rc.2` 至 `UPSTREAM_VALIDATED_VERSION`（当前 `0.2.1-rc.5`）、`0.2.1-alpha.5`、`0.2.0-rc.1` 与 `0.2.0-rc.2`；alpha.5 与 0.2.1-rc.2 至 rc.5、rc.1 与 0.2.0-rc.2 的团队服务、工具与 bundle 包都只差版本号）。读不到版本时（宿主报告 `unknown` 时改读已装版本）用 `UPSTREAM_VALIDATED_VERSION`；其他已知版本（更旧或更新）没有能装进来的团队 bundle，提示先把 DSH 换到支持线之一（不说「升级」：更新的版本要换回去），不给装不上的命令，所以 0.2.0 宿主上给出的是同版本的 `@0.2.0-rc.N`；README 的示例命令随主适配线一起改。
- teammate 页里的团队消息由通用 agent-message 流显示，`relayTextOf` 去掉服务的 `Team message from <name>:` framing 块，正文只留发送内容；发送方显示为会话关系而不是成员名。
- 仪表盘的团队模式不区分「Lead 视角」与「teammate 视角」：第一阶段 teammate 会话不作为 channel 会话打开，所以只有 Lead 会看到它；「进入 teammate 会话」时要一起处理。
- 任务板显示全部非删除任务，不分页；任务很多时靠仪表盘的滚动。
- 子代理详情里的发消息走 `ctx.subagents.prompt`（宿主控制面，teammate 也是 Lead 的 continuable 子代理），不经团队邮箱；团队模式下这条路径没有实测。
- `team_task_list` 卡片只显示当前页，不提示上游的 `nextCursor`（超过 50 个任务时看起来像全部）。
- `/export` 只导出人类输入：团队消息不在导出的 .md 里，由它引发的回复缺少因由。
- `channel.team` 在 teammate 会话里按 header 的 `parentSession` 读 Lead：Lead 已不在 `agents.list()` 时读不到；Lead 名下的普通子代理也会读到团队。第一阶段没有界面读它，第二阶段「进入 teammate 会话」前要改为按成员名单判定。
- 上游限制：teammate 共用工作目录、团队只在单进程内、任务负责人不会自动释放。
