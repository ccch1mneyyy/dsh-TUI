# 独立宿主（方案 B）设计

[文档索引](README.md) · [架构与限制](architecture.md) · [多后端架构](agent-backend-design.md)

## 一句话

dsh-TUI 从「DSH 的一个 Cordis 插件」变成「自己拥有入口与组装根的终端应用」：先挂界面与
后端中立的 channel 核心，再把后端打开。**DSH 仍是首要适配目标与首方后端**——`native.dsh`
与 DSH specialist 能力保持首方特权不变（第 7 节第 1 条）——但它不再是把 TUI 装进去的那层
宿主：它像 claude / codex 一样作为后端之一按需在进程内加载。Claude 内核不组合 dsh-base；它仍
组合一个只装本包行与第三方插件的轻量 profile，第三方插件扩展在两个内核下都保持可用（4.6）。

## 1. 背景

旧链路里界面要等整份 profile（约 94 行 dsh-base + 本包行）组合完、后端打开后才出现（约 2 秒），
Claude 内核也要白等 dsh-base；`DSH_TUI_HOST_ENTRY=0` 仍可退回该链（4.7）。被否的两条路：

- **预载**（`--import` 先画一棵树再换上 live channel）：要逐 `ChannelUi` 端口手写启动态 channel
  镜像并交接。
- **父进程 + IPC 交接 / worker 隔离**：启动屏必须是同一棵已挂载的树、零可见切换，跨进程桥接把
  每个 `ChannelUi` 端口都变成 IPC 协议，维护成本比手写镜像更高（预载方案中做过并回滚）。

方案 B 的前提是多后端重构（#1312、#1313、#1322、#1323）之后：`src/agent/`、`src/backends/claude/`
不 import Cordis，channel 核心后端中立（DSH 专属部分由 `channel/extensions.ts` 按 `native.dsh`
挂载），`tui*` 服务全由本包自己的行提供，`@deepseek-ai/dsh/profile-boot` 提供稳定的嵌入入口。

## 2. 目标与非目标

目标：

- 首帧不依赖任何后端：界面在进程启动后立即以**真实** channel 核心挂载。
- Claude 内核启动时不加载 dsh-base（DSH 的核心行）；第三方 Cordis 插件现有的 `tui*` 扩展
  能力在两个内核下都保持可用（4.6）。
- 启动期没有第二套 channel：「启动中」是一个尚未就绪的会话，就绪时走 channel 现有的接管路径。

非目标：

- 不改 DSH 核心；只使用其公开导出。
- 不做进程隔离（worker / 子进程 + IPC），见第 1 节与第 5 节。
- 不改变 transcript 真源规则：仍以后端持久化记录为准。

## 3. 目标架构

**单根**形态：入口始终建一个 Cordis 根，界面、`tui*` 服务、第三方插件与（DSH 内核下的）DSH
服务都住在这棵树上。

```text
bin/dsh-tui.js（启动器：对齐、安全模式、Windows 解析）
  └─ spawn node <本包 lib/types/dsh-adapter/host-entry.js> <args>
       入口（host-entry.ts → host-dsh.ts）：用已装 dsh 的模块（realpath）建 Cordis 根
         ├─ 模块解析先于任何 TUI 模块加载（宿主那份 react 与 @deepseek-ai/*）
         └─ 本包运行时（plugin.ts 的 apply）挂在这个根上，后端延后打开
              └─ createCoreChannel(cordisChannelHost(ctx), pendingSession, …) ──► render(Chat)
                                                                                  ← 首帧
       内核判定（hostEntryRoute.entryKernel）：
         ├─ claude / codex：首帧后组合轻量 profile（4.6）
         │     └─ 运行时自己打开后端（SDK、转录、CLI 握手）
         │          └─ channel.adoptStartup(session, history)                 可发送
         └─ dsh：设好 DSH_TUI_* 环境变量，把 dsh-tui profile 组合进**同一个根**
               └─ dsh-tui 行经入口发布的槽发现已挂载的界面：**不画第二棵树**
                    ├─ resolveAgent → createDshSession
                    ├─ channel.adoptStartup(dshSession, { attach: dshExtensions })
                    └─ 失败 / 无 dsh-tui 行 → 组合失败上报给界面
```

内核判定沿用 `resolveRememberedBackend`（handoff → 配置行 → `DSH_TUI_BACKEND` → `kernel.json`）；
配置行的 `backend` 由入口直接解析 profile 补丁里 `dsh-tui` 行读取
（`hostEntryRoute.configuredBackend`），不经 app-boot。

依赖方向：界面 → ports；channel 核心 → agent + ports + **`ChannelHost` 接口**；Cordis 只出现在
`src/dsh-adapter/`（DSH 后端与宿主复刻）。仅 DSH 会话用的服务（`agents`、`llm`、`approval` 等）
归 DSH 后端；日志、effect、退出漏斗与 `tui*` 注册表归那个 Cordis 根。

## 4. 关键设计

### 4.1 ChannelHost

扩展现有的 `CoreHost`（`core/host.ts` 的 `resolveCoreHost(host, owner)`），不新造抽象。宿主接口
`ChannelHost`（`channel/channel-host.ts`）只有一个实现 `cordisChannelHost(ctx, services)`
（`channel/cordis-host.ts`），因为入口始终有 Cordis 根；`get(name)` 即原来的 `ctx.get`，其余成员
（logger、runtime、effect、决策/通知分发、`watchServices` 等）见源文件。它的价值不在替换 Cordis，
而在守住 channel 核心的边界：

- **边界门禁**：`src/dsh-adapter/channel/core/` 不得 import 任何 `@deepseek-ai/*`，也不得依赖
  extensions / backend（`scripts/verify-adapter-boundary.ts` 的 `CORE_DIR` 规则）。
- shell / fs / attachments / settings / credentials / dshAuth 与全部 `tui*` 注册表**都不是宿主
  对象的字段**，统一走 `get(name)`：没有该服务时返回 `undefined`，调用点各自降级。
- **注册表实时取**：`resolveCoreHost` 的 `themeHost` / `workspaceService` / `commandTrees` /
  `sceneRuntime` / `settingsSectionsRuntime` / `rendererRuntime` 都是 getter，晚到的组合带来的
  注册立刻可见；`startHostSubscriptions` 经 `watchServices` 在服务变动时重绑，授权存储每次操作重读。

### 4.2 未就绪会话与启动接管

- **占位会话**：合法的最小 `AgentSession`（`status: 'starting'`、`capabilities: { native: {} }`、
  空 history），按**目标内核**的选项构造；`submit` 不发出。
- **启动接管**：`ChannelLaunchOptions.startup` 传入仍在打开的会话（`Promise<{ session, history }>`），
  channel 在 `start()` 里用 binding 的 `prepare` + `adopt` 接管；`prepare` 在打开返回时发现 channel
  已释放或已被 `/new` 换掉就关掉迟到的会话（覆盖「启动期退出」）。尾段不清 `rows`/`pending`（保留
  启动期本地命令打印的行），只重置投影、换身份、`cwd`、能力快照、`subagentControl`、命令表，再
  `bind(history)`。不复用 `newSession` / `resumeSession`：它们在 `working` 时拒绝、会因排队输入放弃
  候选，还会触发 `tui/session-switch` 否决与切换提示。
- **启动期输入**：草稿留在输入框，Enter 提示「还没就绪」，只放行纯本地命令（`isBootSafeCommand`
  白名单：exit/help/theme/lang/vim/kernel 与重试用的 new/resume）。不做「缓冲后重放」：用户会在
  看不到会话状态时把消息发出去。启动期没有发出的输入，所以决策拦截（`tui/input` 等）没有绕过窗口。
- **可延后字段**：`backendLabel`、`messaging`、`subagentControl.history`、`defaultOpeners`、
  `snapshotOf` 的 `dsh` 标记、`attachSessionWorkingActivity` 在 `adoptStartup` 时更新。
- **DSH 扩展晚挂**：启动接管时挂一次扩展，扩展对 `binding.agent` 的读取延后到挂载时。
- **启动失败**：界面落一条提示行（原因 + `/new` 重试 · `/kernel` 切换 · `/quit` 退出），占位会话
  保持绑定、`ready` 为 false。Claude 的 `open` 没有中止入口，进程在打开返回前退出时 CLI 子进程靠
  stdin 关闭自行退出。后端模块本身加载失败（包损坏）时入口报错
  退出；有 dsh CLI 时由启动器的安全模式接住（4.7）。

### 4.3 DSH 后端：进程内加载

`runProfile` 的 `boot()` 必建新根，直接用它即两根；单根形态改为复刻其 `prepare`，用 app-boot 导出
的 `mountRootInclude` 等原语把 profile 组合进入口的根。复刻面与偏差的唯一来源是
`src/dsh-adapter/host-contract.ts`（见 ADAPTER.md「独立入口的宿主契约」）。

- **模块身份**：必须 import **宿主的** `dsh` / `dsh-app-boot` / `cordis`（从 PATH 上 `dsh` 的
  realpath 用 `createRequire` 解析），不能用本包 peer 依赖的副本，否则出现第二个 Cordis 实例。
- **环境变量先于组合**：`cordis.patch.yml` 的 `dsh-tui` 行用 `!!js process.env.X` 读 `DSH_TUI_*`，
  组合时求值，所以入口要在组合前设好；`loadLayeredEnv('dsh')` 会把 `.env` 层写进 `process.env`。
- **根能力守卫**（`HOST_DEVIATIONS` 的 `defer-root-guard`）：守卫在屏幕挂载期间关闭；组合开始后
  由第一个 TUI 行的激活装上（与 profile 路径一致），没有 TUI 行激活则在组合结算时装上。

### 4.4 进程所有权与退出

TUI 本就和 DSH 跑在同一进程里，SIGINT/SIGTERM 处理、`installFailLoud`、`createProcessShutdown`
都在；两根下 `runProfile` 的信号处理不可关闭、会与入口冲突，这是选单根的理由之一。入口拥有退出
漏斗：先恢复终端（raw 模式、光标、alt-screen、同步输出、鼠标、焦点）再让 DSH 的退出继续，另有
`process.on('exit')` 兜底（`process-exit.ts`）。raw 模式下 Ctrl+C 不产生 SIGINT，与今天一致。

### 4.5 设置存储

`~/.dsh-tui/settings.json`（`src/tuiSettingsFile.ts`）+ 设置服务 `src/dsh-adapter/tui-settings.ts`，
两个内核共用；从 profile 补丁的一次性导入与残留字段的行为见 [配置参考](configuration.md#tui-配置)。
DSH 的 Web 设置页改的是 Config，不再影响 TUI。`src/settings/definitions.ts` 与 `tuiSettingsSchema`
继续是唯一定义来源。

依据：`dsh-tui.*` 原本住在 profile 的 Config 行里、经 DSH 带版本围栏的 `settings.mutate` 写回；
Claude 内核不组合 dsh-base 时**写**没有去处。被否的「继续住 Config」会让 Claude 内核下设置只读，
或绕过版本围栏直接写 profile 文件。

### 4.6 插件生态桥接

- **插件代码不需要改**：第三方插件从 `@deepseek-harness-tui/dsh-tui/extensions` 等子路径拿类型、
  `inject: [tuiPanels, …]` 拿服务；单根下注册表就是那个 Cordis 根的同名服务。
- **轻量 profile**：Claude / Codex 内核也要一个能装插件的组合，否则第三方扩展消失。入口在首帧之后
  用 `mountRootInclude` 把一份轻量组合挂到同一个根（裁剪表在 `lite-profile.ts`，组合在 `host-dsh.ts`）：
  裁掉 `dsh-base` 层，只由它提供服务的行按表禁用（依据是行的 `inject` 缺哪些服务）。`dsh-tui` 行
  **始终禁用**——入口自己替代它；清单里没有可裁的层时（`trimmed=false`）其余层整份组合。另建一根
  再桥接被否：第三方行会永久 pending，且 effect 需要第二个释放点。
- **对拍门禁**：`scripts/verify-lite-profile-rows.mjs` 守禁用表与 patch 行 id 的对口，并对拍入口
  默认值 `ENTRY_ROW_DEFAULTS` 与 `cordis.patch.yml` `dsh-tui` 行的静态 config。
- **接线**：组合等首帧刷出后开始；组合成功（已审计）后运行时重读挂载时取值的接缝（主题 host、扩展
  store、toast sink），并把本包的 `/settings` 分节迁到组合的 sections 服务。
- **插件身份**：运行时在所有路径上（含 `dsh --profile`）挂 admission loader
  （`admission-loader.ts`），按第三方插件包根的 `dsh-plugin.json` 准入其激活、把身份绑到插件自己的
  fiber，所以面板等贡献、budget 与 storage 都落在插件自己的身份下；未准入的激活照常运行但不进任何
  受控能力。
- **主题锁**只认 `DSH_TUI_THEME`：`theme.json` 的持久化偏好不算锁，品牌默认档（`branding.ts` 的
  `*_BRAND_THEMES`）在它之上。

### 4.7 启动器

入口是 `lib/types/dsh-adapter/host-entry.js`（`src/dsh-adapter/host-entry.ts`），路由判定在
`src/hostEntryRoute.ts`。

- 启动器保留对齐检查、安全模式重试与 Windows 下 `dsh.cmd` 的解析，**不自行判定内核**：默认所有
  内核都交给入口。入口判定为 DSH 而走委托路径时原样交给 `dsh --profile <profile> -- <应用参数>`：
  环境、stdio 与交接 ACK 管道（fd 3）透传，由真正接管屏幕的 dsh 进程发 ACK，入口只转发退出。
- 入口非零退出且没有 dsh CLI 时，启动器原样退出：安全模式与排查提示都指向不存在的 `dsh --profile`。
- `restartTui` 默认用 `process.execPath` + 原 argv 重起；启动器给了 `DSH_TUI_HOST_ENTRY_PATH`（且未被
  `DSH_TUI_HOST_ENTRY=0` 关闭）时，任何内核的替身进程都经入口重起（`restartArgv`，只带 dsh `--`
  之后的应用参数）。
- 一次性开关（`--version`、`--dump-config*` 等 dsh 前缀参数）继续直接交给 dsh。
- 关闭开关 `DSH_TUI_HOST_ENTRY=0`：所有内核回到 `dsh --profile`。设置文件（4.5）不随开关回退。

## 5. 已知并接受的限制

- **DSH 加载的同步阻塞**：DSH 的模块加载与组合在进程内有约 1 秒的同步段，期间界面不刷新，只能
  「先画后冻」；不走进程隔离（第 1 节）。首帧侧的缓解（启动器注入 `NODE_COMPILE_CACHE`、首帧模块
  图瘦身）只作用于本包入口路径。
- 内核在一次进程里只接管一次；运行中切换内核仍要重启（`/kernel`）。
- `dsh --profile dsh-tui` 直接启动保留（第 7 节第 2 条）：没有入口时 `dsh-tui` 行按既有路径自己渲染。

## 6. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 入口复刻的宿主接口在 DSH 新版本漂移（`host-contract.ts` 的 HOST_MODULES / HOST_REPLICAS） | DSH 内核启动失败 | 能力探测 + 回退到 `dsh --profile`；`verify:contract` 的复刻指纹（`host-replica.snapshot.json`，按声明文件整文件哈希，信号偏粗）与版本线 |
| 宿主模块身份解析错误（加载了第二份 Cordis） | 插件服务注册到错误的根 | 只从宿主 realpath 解析；回归里断言单实例 |
| 设置迁移出错 | 用户设置丢失或回到默认 | 迁移只读不删原值；失败时继续读旧层 |
| 轻量组合判「有没有可裁的层」看的是 `lite-profile.ts` 里**写死的 bundle 名** | dsh-base 的行改经别的 bundle 名进清单时被判成无可裁，整份组合（`dsh-tui` 行仍禁用） | 版本线移动时复核 bundle 名 |
| Claude / Codex 内核下第三方插件缺失或注册表归属与上游冲突 | 插件扩展退化 | 轻量 profile（4.6）；注册表归属待与上游插件契约（#1247）对齐 |

## 7. 已定结论

| # | 议题 | 结论 |
| --- | --- | --- |
| 1 | 定位 | 「拥有入口的终端应用」；DSH 仍是首要适配目标与首方后端（`native.dsh` 与 specialist 能力的首方特权不变），只因其启动成本以独立后端形态存在 |
| 2 | `dsh --profile dsh-tui` 直启 | 继续支持；没有专项实现与验收，现有覆盖仅启动器的 `DSH_TUI_HOST_ENTRY=0` 回退（`verify-launcher.mjs`） |
| 3 | `@deepseek-ai/dsh` | 不是依赖：入口按宿主 realpath 加载已装的 `dsh`，只为类型声明 `HOST_TYPE_PACKAGES`（4.3） |
| 4 | 设置存储 | 独立的 `~/.dsh-tui/settings.json`，两个内核共用（4.5） |

## 8. 未完成项

- **验收**：Claude 内核已用隔离 profile + 测试插件（主题、面板、决策拦截）在真实终端验收；Codex 内核
  走同一条组合路径但未验收。`/theme` 的交互路径（选主题到上屏）在轻量与 DSH 内核上都没有验收覆盖。
- **成本**：轻量 profile 自身的组合成本要计入 Claude 内核的首帧对比基线。
- **上游插件契约**：本包的注册表归属、grants 与 `apiVersion` 要与上游 issue #1247 的插件契约对齐，
  不要先冻在「注册表住在 Cordis 树里」上。
