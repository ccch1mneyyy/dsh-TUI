# Codex 原生后端（实验性）

[文档索引](README.md) · [English](codex-backend.en.md) · [多后端架构](agent-backend-design.md)

dsh-TUI 可以作为你本机 Codex 的前端：界面不变，会话由 `codex app-server` 驱动，
而不是由 DSH 智能体或一个通用 OpenAI API 适配器驱动。Codex 自己加载配置、登录、
`AGENTS.md`、skills、hooks 与 MCP；thread 与官方 CLI 共用，不需要迁移历史。
`dsh-tui migrate codex` 是另一件事：它把历史导入 **DSH**，不是打开原生 Codex thread。

> 本文描述当前开发分支，不表示已发布。协议验证基线为 **codex-cli 0.160.1**，最低
> **0.144.0**；其他版本可能有 drift 提示，最低版本并不保证每项进阶接口都可用。
> 控制面、会话生命周期与进阶能力按实际能力声明提供。协议/假 app-server 回归与
> 无凭据离线检查不等于真实 ChatGPT 登录、真实模型回合或真实 TTY 验证；本轮这些
> 真实路径未运行。已验证范围单列于文末，实施与实测记录见[施工日志](codex-backend-progress.md)。

## 安装与启动

先按[安装说明](getting-started.md)安装 dsh-TUI，再安装你自己的 Codex：

```sh
npm install -g @openai/codex@0.160.1
codex --version
dsh-tui --backend codex
```

- dsh-TUI 不捆绑 Codex 二进制，也不要求安装 `@openai/codex-sdk`。
- 默认从 `PATH` 找 Codex；`CODEX_EXECUTABLE` 可指定可执行文件。Windows 的 npm
  安装会解析到真正的 `codex.exe`，不要把启动包装脚本当成二进制。
- 启动页「内核」或会话里的 `/kernel` 也能选择 Codex；选择会被记住。一个进程只用
  一个后端，切换需要重启，不能在回合进行中切换。也可在 dsh-tui 配置行写
  `backend: codex`，或设置 `DSH_TUI_BACKEND=codex`；显式启动选项优先于记住的选择。
- 仍使用你的 `$CODEX_HOME`（默认 `~/.codex`）和官方配置。dsh-TUI **不写
  `~/.codex/config.toml`**；自己的模型、effort、权限等选择保存在
  `~/.dsh-tui/backends/codex/prefs.json`，按 thread 请求应用。
- 后端标识/标题显示 Codex；不会自动更换配色、宠物或你的主题选择。

恢复官方或 dsh-TUI 建立的 thread：

```sh
dsh-tui --backend codex --resume <thread-id>
dsh-tui --backend codex --resume   # 本机 dsh-TUI 最近使用的 Codex thread
codex resume <thread-id>           # 换回官方前端（先退出占用它的进程）
```

恢复失败会明确报错，不会悄悄另开新会话。恢复默认沿用 thread 原来的工作目录。官方
选择器可能按当前目录与默认 provider 过滤；看不到时改看全部目录/provider，或直接用 id。
同一 thread 不能同时被两个 Codex 写进程打开；“已有活动写入者”提示表示需要先在另一
终端正常退出该 thread，不要删锁或杀掉不属于你的进程。

## 登录与凭据

### 选用顺序

1. **激活的 `/channel` 渠道连接**：使用该渠道的 Responses API 与 key，不注入订阅令牌。
2. **dsh-auth 的 `openai-codex` ChatGPT 订阅登录**：仅在确定是第一方 OpenAI 路由时，
   以官方 `chatgptAuthTokens` 外部托管模式交给 app-server。传给 Codex 的令牌仅在
   内存中，不写 Codex 的 `auth.json`，刷新由 app-server 反向请求。
3. **你已有的原生 Codex 凭据**：由 Codex 自己读取 `$CODEX_HOME` 的凭据文件/钥匙串、
   环境变量与 provider 配置。dsh-TUI 不复制、更改或重新解释它们。
4. 都没有时仍可打开界面，但模型调用前需要 `/login`。

订阅令牌不会发给中转站：自定义 `model_provider`、被改写的 provider base URL、
指向非官方主机的 `OPENAI_BASE_URL` 或无法读取的配置都会阻止注入；环境原样交给 Codex。非第一方
路由应使用自己的 provider 凭据或渠道 key。读取账户状态只显示凭据来源、订阅类型
与主机，不显示邮箱或 key。

### `/login` 的三种方式

| 方式 | 用途与存储 |
| --- | --- |
| 内置 ChatGPT OAuth | 使用标准 profile 的 dsh-auth 登录向导；没有该 OAuth 服务时不显示这项。凭据由 dsh-auth 管理，给 Codex 的外部令牌不落到 Codex 凭据文件 |
| Codex 设备码 | 按界面给出的验证链接与一次性代码在浏览器完成登录；由 Codex 自己管理原生登录存储，可在界面取消等待 |
| OpenAI API key | 在保密输入框填写；**会写入你自己的 Codex 凭据存储**，不是临时内存 key。想使用中转 key 应在 `/channel` 配置，不要用这项冒充第一方登录 |

登录是否成功以服务端结果为准，不能把 `account/login/start` 的即时应答当成成功。
刷新或托管令牌失败会提示 `/login` 并停止注入；**不会调用 `account/logout`，不会
删除你已有的原生 Codex 登录**。`/logout` 只调用宿主 OAuth 服务，移除对应
`openai-codex` 的 dsh-auth 存储；不会删除渠道 key、其他 provider 或原生登录。
现有 app-server 可能仍缓存已载入的托管令牌，**需要正常重启 dsh-TUI 后停止使用**；
登出不会自动中断会话、重连或修改官方配置。需要管理原生登录时，在自己的外部终端
使用官方 Codex。

在第三方客户端使用 ChatGPT 订阅令牌受 OpenAI 条款约束；外部托管是官方 app-server
接口，不代表本项目保证所有订阅/工作区都允许第三方前端。没有真实账号验证的登录
路径不能视为已验证；有顾虑可使用 API key。不要把凭据或账户信息贴进 issue、日志或文档。

## 中转渠道：`/channel`

渠道只支持 **OpenAI 兼容 Responses API**（`wireApi: responses`），不支持把
Chat Completions 端点当作 Responses 使用。通过 `/channel` 选择/新建渠道、设置连接
和模型 exact 映射；也可从当前 Codex provider 设置导入（可读取对应环境 key 时）。
模型名映射是精确替换，不是 Claude 的模型 tier。

- 元数据在 `~/.dsh-tui/backends/codex/channels.json`，文件只存 `tokenRef`；key 在
  DSH 凭据库，不写进该 JSON。不要把 key 塞进 `env` 或 URL。
- base URL 只接受 HTTPS；HTTP 仅限 `localhost` 和 `127.0.0.1`。拒绝用户名/密码、
  查询参数、fragment，以及 `sk-`、`key=`、长随机串等像凭据的路径段。
- provider 定义通过 `codex app-server -c ...` 的进程参数传递，key 只在子进程环境。
  **端点主机名和非敏感 provider 参数可能被本机其他用户在进程列表看到**；环境
  也不是防管理员的秘密存储。只使用可信的本机与端点。
- 激活的连接不完整、缺 key 或 URL 不安全时会拒绝启动，不会偷偷退回订阅登录。
- 渠道登录与 ChatGPT 登录不要混用；激活连接时 `/login` 会提示先处理渠道。切换
  连接会按界面提示重启，以新的 provider/凭据环境恢复当前 thread，不中断正在进行的
  回合；只改模型映射的档案切换可不重启。不要在运行中改连接。

## 模型、思考强度、Plan 与权限

`/model` 列出 Codex 报告的模型与渠道映射；`/effort` 只给出当前模型实际支持的档位，
不是每个模型都有 `xhigh`。选择模型时会处理不兼容的 effort；默认 effort 交给模型。
空闲时设置立即更新，运行中的改动用于下一回合，不改变已开始的推理。

**协作模式和权限是两个正交维度**。`/permission` 复用现有选择器：

| 项 | 审批与沙箱 |
| --- | --- |
| Read Only / 只读（`read-only`） | 按需审批、只读沙箱 |
| Default / 默认（`auto`） | 按需审批、工作区可写沙箱 |
| Full Access / 完全访问（`full-access`） | 不询问、无文件沙箱；仅在明确选择时进入 |
| Plan（`plan`） | 规划协作模式；保留已有权限档，不以 Plan 替代沙箱 |

- **`Shift+Tab` 只开/关 Plan**，退出回到进入前的权限档，不循环到 Full Access。
- `/plan` 切到 Plan；`/plan <任务>` 切换后立刻提交任务。选择一个具体权限档会回到
  Default 协作模式。Plan 不等于“所有工具都被禁止”，安全边界仍由 Codex 权限决定。
- 默认来源按字段为：dsh-TUI 中明确选过的值 > 用户 Codex 配置 > 未设置时的
  `auto`。读取配置失败时不拿 `auto` 覆盖未知配置。
- 计划完成后会出现实施确认：实施、清上下文后实施、留在规划/反馈继续。清上下文
  的路径以新 thread 继续，原 thread 保留；批准计划不会暗中打开 Full Access。
- 命令、文件改动、网络/权限请求由 Codex 给出的选项驱动；允许本次、会话内允许、
  记住规则等选项只在服务端支持时出现。问卷与 MCP 表单共用现有面板，保密答案掩码。

## 日常命令与输入

| 入口 | 行为 |
| --- | --- |
| 工作时 `Enter` / `Tab` / `Ctrl+Enter` | 插话（steer）/ 排队下一回合 / 打断并立即发送；不可 steer 时退为排队 |
| `Esc` / `Ctrl+C` | 按当前焦点关闭面板或中断；取消提问也会中断相应回合，避免挂起 |
| `/review` | 审查未提交改动，结果 inline 展示；需要空闲，消耗模型用量 |
| `/review base <branch>` / `/review commit <sha>` | 按分支基线或提交审查；其他参数作为自定义审查说明 |
| `/diff` | 最近回合的聚合 diff；没有时尝试相对远端的 Git diff，再无内容则提示 |
| `/<skill-name> [参数]` | 使用 Codex 发现且启用的 skill；补全随 skills 变化刷新，本地同名命令优先 |
| `/init` | 提交 Codex 的 AGENTS.md 初始化提示，不走 DSH 的模板生成器；这是模型回合，仍需审批/用量 |
| `/mcp` | 查看 Codex MCP 服务器状态与工具数，支持 reconnect，不提供运行时 toggle |
| `/usage` | 服务端额度窗口、使用百分比、重置时间与 credits；中转站可能不提供 |
| `/status`、`/context`、`/compact` | 状态、上下文原始读数、Codex 压缩；没有分类明细时不会编造 |
| `/new`、`/clear`、`/export` | 新 thread、仅清视图、导出当前转录；`/clear` **不重置上下文** |
| `!cmd` / `!!cmd` | dsh-TUI 的本地 shell / 把输出作为后续消息带入上下文；不是直接照搬官方 `!` 的持久化语义 |

文件工具卡显示真实 hunk 行号；命令卡在运行中显示有界实时输出尾部。按 `Ctrl+O`
展开详情。历史中的官方 `userShell` 回合也会显示为终端卡。

### 上下文与额度的读法

上下文条使用官方 12,000-token 基线公式（`T` 是最近一次 `last.totalTokens`，不是
全会话累计计费用量；`W` 是模型窗口）：

```text
effective = max(0, W - 12000)
used      = max(0, T - 12000)
占用比例   = used / effective       # effective > 0 时
剩余比例   = 1 - 占用比例
```

显示会处理未知/无效窗口；`/context` 明细保留原始 `T / W`。账本 tokens、订阅额度
与上下文占用是不同量，不能相互代替。Codex 转录通常不保存完整计费用量，恢复历史
不会凭空重建先前所有 tokens/费用；等待新的用量通知更新。

## 会话生命周期

- `/resume` 打开原生 thread 浏览器，按项目分组，也可看全部项目。`Enter` 恢复、
  `Ctrl+R` 改名、`Ctrl+D` **归档**；确认和完成提示都说明记录保留，不物理删除。
  当前使用中、其他终端占用或内部 worker 活动的 thread 不能归档。目录最多列出
  最近 500 条普通 thread，临时 fork 与子 thread 不混进主列表。
- `/rename` 改官方 thread 标题；`/color` 只保存会话强调色，不改全局主题。
- `/fork` 创建可恢复副本，不自动切换；双击 `Esc` 或 `/rewind` 的对话回退在
  所选提问之前创建副本并继续，提问回到输入框、原 thread 保留。首条提问回退会
  得到空 thread。**不支持文件回退或对话+文件回退**，Git 工作树不会随对话恢复。
- 恢复先回放最近 20 个完整回合，再接 live；加载更早消息使用预取的完整分页，
  不拿省略工具项的 summary 当全转录。预取尚未就绪时可再试一次，连续失败会提示。
  运行中的恢复会去重重发审批；历史没有的完整用量不伪造。

## 图片

粘贴图片或 `@` 引用 PNG/JPEG/GIF/WebP 文件随消息发送。每张最多 **20 MiB**、
每边最多 **2048** 像素、最多 **2048 × 2048** 像素；每条最多 **20 张**、合计
**50 MiB**。暂存层按能力限制校验，发送前再次读图检查；超限按提示缩小图片，
不要假设 Codex 自动处理了未成功发送的附件。

输入发成 data URL 随 thread 持久化，不依赖会被清理的剪贴板临时路径。恢复会显示
持久化的输入图片；历史 localImage 文件丢失则显示不可用占位，不自动下载远端图片。
Codex 的 imageView/已完成 imageGeneration 也会显示图片：生成结果优先读
`savedPath`，没有路径才读内嵌结果。真实模型看图与生成图像尚未在本轮验证。

## 子代理与后台任务

- `/agents` 或 `Ctrl+A` 打开子代理面板。子 thread 文本、工具与用量进入其卡片/
  详情，不混进主对话；详情按需分页读取，可中断自己会话下正在工作的子代理。
- 可给子代理发消息，但采用 **parent-mediated**：由父模型通过 Codex 的
  `send_input` 转达，不是直接操纵子代理 inbox。发送回执表示已发起（issued），
  不保证子代理已读或已执行；跨父会话的详情/中断会被拒绝。
- `/jobs` 显示 Codex unified-exec 留下的后台终端，可用现有任务停止控件结束。
  回合开始/结束刷新名册，发现存活终端后约每 **2 秒**轮询；这是实验接口，缺方法
  时能力关闭并提示，不假装后台进程已完成。
- 输出是本会话已观察到的**最后 64 KiB**尾部，不是任意历史输出文件读取。恢复
  时未观察到输出可以显示无输出；完整名册查询证明消失后才结算。没有原生退出码
  时完成卡的摘要注明 **exit unknown**，不能据此声称 exit 0 或命令成功。
- 中断主模型回合与停止后台终端是不同动作；需要终止任务时用任务停止控件。

## 目标、旁问与 hooks

| 入口 | 行为 |
| --- | --- |
| `/goal` | 当前目标、状态、tokens/时间预算；数值来自 Codex 服务端 |
| `/goal <目标>`、`/goal edit <目标>` | 创建或替换原生目标 |
| `/goal --budget 50k <目标>` | 设置 token 预算（也接受 50000、1.5m） |
| `/goal pause`、`/goal resume`、`/goal clear` | 暂停、继续、清除目标；不复制 DSH 的自动轮次循环 |
| `/btw <问题>`、`/recap` | 临时 fork 的旁问/回顾，一次模型调用，不写主 thread 或持久会话列表 |
| hooks | hookPrompt 作为注入消息；开始/完成/失败以通知呈现，沿用 Codex 配置而非 DSH `/hooks` 管理器 |

目标遇 usageLimited/budgetLimited 会显示阻塞与原因；不支持目标接口的版本不会
声明该能力。`/btw`/`/recap` 以只读沙箱、禁止审批提升运行，要求仅回答并拒绝
工具/审批请求；取消会中断临时回合并卸载 fork。它们仍消耗模型额度，不是免费本地
摘要。临时 fork 的创建/非持久行为已离线检查，真实旁问模型结果未在本轮验证。

## 限制与排障

- `/skills`、`/hooks` 是 DSH 管理入口，不等于 Codex 自己的技能/钩子管理。Codex
  skills 用菜单中的 `/<skill-name>`；不要把不支持的本地命令当成可透传给模型。
- DSH 的 preset、provider、工作区首页、迁移管理与 `/tree` 等不是 Codex 能力。
  不支持的命令会被标不可用，不会静默执行。
- 本期不增加官方所有 slash 别名，也不实现 Codex 的语音、apps/plugins 管理、
  worktree/daemon、宠物、memories、远程控制或物理删除。主题/宠物继续用 dsh-TUI
  现有设置，不为“原生兼容”改配色。
- `/doctor` 可核对二进制版本/路径、drift、Codex home、凭据来源、provider 主机、
  沙箱问题与协议未知项。Linux 缺 bubblewrap 时按提示安装并保留需要的沙箱，不要
  仅为消除报错就选 Full Access。操作系统沙箱行为由官方 Codex 决定。
- 401/登录失败：检查当前渠道和路由后 `/login`；额度超限看 `/usage`；窗口超限
  先 `/compact`；“active writer”先退出另一终端的会话。
- app-server 退出会提示重连；重连失败后会话保留为只读，不假装消息已送达。
- bug 报告只带版本、平台、最短步骤和脱敏诊断。会话导出、原始 ANSI/debug 日志
  可能包含正文、文件路径与机密，不应直接公开。

## 本轮验证范围

- 真实官方 0.160.1 app-server 在隔离 home 下 9 项离线检查通过：握手/隔离 home、新建 thread、模型列表、零上下文读数、权限与 Plan 正交、改名持久化、临时 fork、完整页恢复、归档。没有模型回合，不收费，不写用户的 ~/.codex/config.toml。
- 协议/映射、控制面、生命周期与进阶接口用假 app-server 和脱敏 fixture 回归；归档/普通删除的真实无头浏览器与宿主 OAuth-only 登出也有聚焦回归。它们验证接线、状态与安全边界，不等于真实服务端已经接受所有账号/模型请求。
- 本轮未运行：真实 ChatGPT OAuth/设备码/API-key 登录、带凭据模型回合、真实图片/子代理/后台终端/goal/旁问回合，以及真实 TTY 的 inline/fullscreen/窄终端操作。凭据缺失或没有交互终端时不把跳过写为通过；详细结果见施工日志。
