# 配置参考

[文档索引](README.md) · [English](configuration.en.md)

## Profile 与补丁层

通过 npm/profile 机制安装后，用户配置位于：

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

`DSH_HOME` 未设置时通常为 `~/.dsh`。该文件是顶层 YAML 数组，可使用 DSH
支持的 `!!js` 表达式。

Profile 启动按顺序叠加：

- `dsh-base`
- 已安装的 bundle
- `@deepseek-harness-tui/dsh-tui` 包内的 `cordis.patch.yml`
- 用户补丁（最后应用）

用户配置通常通过相同 `id` 覆盖已有行；只有确实新增服务时才用 `insert`。

> 覆盖某一行时，`config` 是整块替换，不是逐字段深合并。需要继续生效的字段必须
> 在用户补丁中全部重写。

## 官方请求元数据与反馈上报

TUI bundle 继承已安装 DSH 官方组合的上报配置；上游未提供的服务不会由 TUI
补装。当前验证线的默认行为如下，profile、home 和命令行补丁仍可覆盖：

| 配置 | 官方默认 | 发送内容与触发条件 |
| --- | --- | --- |
| `plugin-package-inventory-deepseek.enabled` | `true` | DeepSeek 官方 API 请求中的 `dsh_plugin_packages`，包含活跃插件包的名称与版本，可用于识别 TUI 使用量 |
| `session-log-deepseek.enabled` | `true` | DeepSeek 官方 API 请求中的 `dsh_session_log`，增量携带规范会话事件，包括会话内容；与插件包清单分别控制 |
| `session-telemetry-otel.mode` | `FEEDBACK_ONLY` | 新的显式反馈授权通过 OTel 上传截至反馈的会话日志前缀，包含上下文；普通聊天不触发该通道 |

前两项是模型输入之外的请求元数据，不增加模型输入 token。它们只随对应的
DeepSeek 请求发送，不能据此统计 Claude/Codex 后端的全部 TUI 使用。

反馈遥测支持上游环境变量：

- `DSH_TELEMETRY_MODE=DISABLED`：停止 OTel 会话日志上传；默认的 `FEEDBACK_ONLY`
  仍只在反馈后授权上传。
- `DSH_TELEMETRY_DISABLED`：任何非空值（包括 `0`、`false`）都会在启动时禁用
  `session-telemetry-otel` 行。恢复时删除变量；它不控制上述两项 API 请求元数据。
- `DSH_TELEMETRY_OTLP_URL`：覆盖 OTel collector 地址；未设置时使用已安装官方
  版本的端点和导出参数。

若需停止 API 请求元数据，可在用户 profile 补丁中分别关闭：

```yaml
- id: plugin-package-inventory-deepseek
  config:
    enabled: false
- id: session-log-deepseek
  config:
    enabled: false
```

修改 bundle 或启动环境后重启 TUI，既有用户补丁不会被恢复默认的操作删除。

## TUI 配置

DSH 0.1.7 的 `/settings` 写入当前 profile 的 `cordis.patch.yml`，字段属于插件
Config；旧版仍使用 `~/.dsh/settings.yaml`。不要把旧文件路径当成新版设置入口。
语言、布局等偏好实时更新；全屏和图片预览需 `/restart`。

下面是完整的常用覆盖示例：

```yaml
- id: dsh-tui
  config:
    provider: deepseek-official
    model: deepseek-flash
    # cwd 不建议显式设置——默认解析为启动目录所在的 git worktree 根；确需固定
    # 工作区时写绝对路径（如 cwd: /repo/packages/app），不要用
    # `!!js process.cwd()`（那会把工作区钉死在启动子目录上，issue #96）。
    effort: max
    activity: true
    activityFrames: moon8
    contextBar: true
    fullscreen: false
    terminalImages: true
    preset: !!js process.env.DSH_TUI_PRESET ?? undefined
    workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined
    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined
```

| 字段 | 默认/来源 | 说明 |
| --- | --- | --- |
| `provider` | Harness `agentDefaultModel`；裸组合回落 `deepseek-official` | DSH 模型路由名称；只有 provider 与 model 同时配置才构成显式路由 |
| `model` | Harness `agentDefaultModel`；裸组合回落 `deepseek-flash` | 启动模型；`/model` 可通过 session fork 实时切换。优先级：`/model` 持久化选择（`~/.dsh-tui/model.json`，上次实际运行的路由，完整 pair）> 此处的完整 `provider`+`model` 对（部署默认值）> Harness 默认。半 pin（只有 `provider` 或只有 `model`）视为未设置，绝不与偏好拼成半个路由（issue #67） |
| `cwd` | 启动目录所在的 git worktree 根（不在任何 worktree 内时为 `process.cwd()`；家目录的 dotfiles 仓不算） | TUI 会话侧工作区：agent meta、`@` 补全/提及展开、/resume 过滤、状态栏；恢复已有会话时以该会话持久化的 cwd 为准。注意 bash/fs-policy/sandbox 的根仍由组合层 cordis 配置决定（默认启动目录，归 dsh-base 管），与这里的会话侧 cwd 可能不同 |
| `workspace` | 未设置 | 启动工作区目标；可用本地路径、`file://` URI 或插件提供的 URI，设置后优先于 `cwd` |
| `effort` | 配置层通常为 `max` | 每个请求实际生效的推理等级（按运行时模型档位校验，非法档位静默回落默认；兼作顶栏启动显示）。优先级：/settings 的 `effortDefault`（`auto` 时让位）> `/effort` 持久化选择（`~/.dsh-tui/effort.json`，上次实际运行的档位）> 本字段（部署默认值）> 模型默认 |
| `effortDefault` | 未设置 | 新会话默认推理强度（`/settings` 用户层，显式设定时优先于持久化 `/effort`）；`auto` 让位给持久化选择与 `effort`，可经 `/settings` 修改 |
| `whale` / `whaleIdle` | `true` / `true` | 标题鲸鱼与欢迎页鲸鱼闲置动画 |
| `splashFont` | `daily` | 开屏大字字体：`daily` 按本地日期轮换（默认），其余取字体 id（`bold` / `square` / `bevel` / `wide` / `dot` / `stencil` / `classic` / `slab`）pin 住那一款；非法值回落 `daily`。也可经 `/settings` 修改 |
| `whaleGirl` | `false` | 把标题的像素鲸鱼换成女仆娘：**最优先**真图（Kitty/Sixel）；不支持时回落字符画版女仆娘 |
| `minimal` | `false` | 极简界面（Minimal UI）：精简标题装饰与配色。**这是界面显示开关**，与下面 `preset` 里的内核「极简模式」预设完全是两件事（那个才决定模型能用哪些工具） |
| `sidePanel.splitEnabled` | `true`（布尔） | 分栏总开关：开启时 `Ctrl+B` 与 `/panel` 在聊天右侧展开侧栏；关闭时两者都不再分栏，`/jobs` 等仍走整屏面板。立即生效 |
| `sidePanel.open` | `false`（布尔） | 启动时侧栏是否已展开；默认关闭，升级后布局与原来一致。会话内的 `Ctrl+B` / `/panel toggle` 不写回这里。立即生效 |
| `sidePanel.ratio` | `0.68`（数值，0.1–0.95） | 聊天列占内容宽度的比例；侧栏有焦点时 `+`/`-` 在当前会话内实时微调（不写回）。立即生效 |
| `sidePanel.panels` | `todo,jobs,agents,info,trajectory,workspace,btw,companion`（逗号分隔文本） | 默认启用全部 8 个内置面板；这里控制面板 id 与顺序。格式合法但暂无面板认领的 id 会留在标签栏等插件注册，格式非法的条目被拒绝。面板栏右端的 `⤢` 把当前面板放大成整屏（只对声明了整屏形态的面板出现）。立即生效 |
 | `companion.skin` | `deepy` | 宠物面板的皮肤：`deepy`（默认，deepy 小鲸鱼素材包）、`whaleGirl`（鲸娘表情包，22 个动画含互动反应）或 `whale`（与开屏同款分层像素鲸鱼）；面板默认启用，可在 `sidePanel.panels` 调整。立即生效 |
| `btw.contextTurns` | `4`（数值，1–8） | `/btw` 追问时带上的最近已完成问答组数；更早的组不进请求，线程和面板里仍保留。立即生效 |
| `btw.contextBudget` | `24000`（数值，1000–200000） | `/btw` 追问携带的最近问答总字符数上限，超出时从最旧的一组开始丢。立即生效 |
| `codeFrameStyle` | `light` | 回复里代码块的边框：`light` 只有顶部标签和左侧竖线，不多占行；`full` 是封闭的框。终端太窄时总是用纯文本 fence。立即生效 |
| `turnUsageRow` | `false`（布尔） | 每回合末尾显示一行右对齐的用量（输入/输出、缓存、耗时、重试）；关闭时 `/tokens`、`/status` 和底栏悬停照样能看到这些数字 |
| `modes` | 内置三档 | Shift+Tab 会话模式循环（plan/sandbox/approval 原子组合）；缺省为 默认 → 计划 → 完全访问 |
| `upstreamRetry` | `true` | 为当前会话实际使用的 `llm-pi-ai` 渠道播种重试策略（最多重试 5 次，失败码覆盖传输类中断、含 `STREAM_CLOSED` 上游断链）：每次绑定（启动、`/model` 切换、resume）时检查该渠道，未声明 `retryPolicy` 才写入官方 `llm-pi-ai` settings 分节——内核 `llm-retry` 插件执行的就是这份策略。从不写闲置渠道；已显式声明 `retryPolicy` 的渠道（cordis.yml 或手改 settings）不会被覆盖；`false` 整体关闭 |
| `activity` | `true` | 是否显示实时工作状态行 |
| `activityFrames` | `moon8` | 工作状态动画预设；也可通过 `/activity` 修改。旧配置值 `claude` 读取时映射为 `moon8`，选择器不再显示该旧预设 |
| `contextBar` | `true` | 输入框下方的分段上下文进度条；`false` 隐藏该行。与 `/settings → statusBar.contextBar`（默认开）同时为开才显示 |
| `fullscreen` | `true`（0.9.0 起出厂默认） | `true` 使用 alternate screen、应用内滚动和鼠标选区；`false` 使用 inline 模式 |
| `terminalImages` | `true` | 允许在支持的终端预览图片；`false` 保留文字信息，跳过图片探测与预览解码。修改后重启生效 |
| `preset` | 名册默认 `standard` | 新会话 Agent preset；优先级：`DSH_TUI_PRESET`（本次运行）> `/preset` 持久化选择 > 本字段（部署默认值）> 名册默认 |
| `sessionId` | 未设置 | 要恢复的会话 ID，通常由 Windows `--resume` 启动器注入 |
| `backend` | 未设置（`/kernel` 记住的选择，否则 `dsh`） | 会话后端：内置 `dsh`，或已装的后端（实验性的 `claude` / `codex`，以及插件后端；不区分大小写）。**未安装或未知的取值一律按 `dsh` 启动并告警**，不会崩。profile 行读取 `DSH_TUI_BACKEND`，`dsh-tui --backend <id>` 会设置它。见 [Claude 后端](claude-backend.md) |

### 优先级与强制关闭

- `/settings → 终端图片预览` 保存的选择优先于 `config.terminalImages`。
- 未保存时用配置值，默认开启。
- 开启仍需终端支持 Kitty graphics，且处于允许图片渲染的显示模式。
- `DSH_TUI_DISABLE_TERMINAL_IMAGES=1` 始终强制关闭预览。
- 关闭后不读取、不解码图片，也不发图片渲染指令；向模型发图片不受影响。
- 勾选框编辑的是预览偏好；环境变量强制关闭时，设置行会单独标明「环境强制关闭」。

### 重启生效

- 这个开关在启动时读取。
- 修改后用 `/restart` 自动重启 TUI 并恢复当前会话；`/reload` 不应用。
- 回合运行中需先等结束，或用 `Ctrl+C` 停止再重启。

## 诊断环境变量

以下变量用于诊断或实验性终端集成，默认均关闭；只有显式设置时才生效：

| 变量 | 作用 |
| --- | --- |
| `DSH_TUI_DEBUG_REPAINTS=1` | 记录重绘诊断信息 |
| `DSH_TUI_COMMIT_LOG=1` | 记录渲染提交诊断信息 |
| `DSH_TUI_ACCESSIBILITY=1` | 启用无障碍相关显示路径 |
| `DSH_TUI_TMUX_TRUECOLOR=1` | 在 tmux 中启用 truecolor 探测路径 |
| `DSH_TUI_TAB_STATUS=1` | 实验性终端 tab 状态 opt-in；默认关闭，不保证任意终端支持 |

诊断输出不会改变会话事件或模型路由；遇到终端兼容问题时，只按需启用相关变量。

## 工作状态行

`dsh-working-activity` 随包安装，并由本包 patch 插入。工作状态行读的是该插件
（≥ 0.5.0）发布的 `workingActivity` 会话投影——0.5.0 起事件出口
（`activity/status`）已由投影取代，旧版插件不会产生工作状态行。只需要按 ID
覆盖参数：

```yaml
- id: working-activity
  config:
    publishIntervalMs: 500
```

不要再次 `insert` 同名行，也不要对同一 profile 单独执行
`dsh plugin ... add dsh-working-activity`。

## Agent Preset

每个会话通过官方 preset registry 组合模型可见的工具和提示词。0.1.7 使用
`@deepseek-ai/dsh-agent-preset-registry`，旧版使用 `@deepseek-ai/dsh-agent-presets`：

| ID | 名称 | 能力 |
| --- | --- | --- |
| `standard` | 标准模式（默认） | 编辑、Shell、检索、Skills、计划、Goals、子代理与工作流 |
| `ptc`（0.1.2）/ `code`（旧 0.1.1） | PTC 模式 | 标准能力，加 PTC SDK 呈现工具，可用 TypeScript 组合多步操作；两个名字可跨版本兼容解析 |
| `minimal` | 极简模式 | 内核 Agent 预设：只暴露一个持久 shell 工具（POSIX 为 bash，Windows 为 pwsh），不带 compaction、计划模式与运行时上下文。`str_replace_editor` 自 0.1.3-alpha.2 起是 opt-in，该预设不含它。代价也如实说：没有压缩、也不剪枝工具结果（长会话可能撞上下文上限，超长工具输出整段留在上下文里），`/compact` 与问卷在该预设下不可用——Help 与 `/` 补全标注「不可用」，进入/恢复该预设时提示一次 |
| `cordis` | 创造模式 | 标准能力，加运行时检查与插件实验工具 |
| `liangshen` | 梁神模式 | 主 Agent 与子 Agent 首轮均保持极简模式的最小工具面，首次工具调用后开放完整目录，压缩后重新锚定 |

> ⚠️ 别把这里的「极简模式」和 `/settings → 外观与布局 → 极简界面`（Minimal UI，配置键 `dsh-tui.minimal`）搞混：
> 本节的 preset 是**内核 Agent 预设**，改变的是模型能看到、能调用的工具；
> 「极简界面」只精简界面装饰（开屏头部、emoji 状态符、装饰配色与底栏字段），
> 对模型能力没有任何影响。

### 选择与切换

- `/preset` 打开选择器。
- `/preset <id>` 直接选择；`/preset status` 查看当前状态。
- 选择器显示的名称与描述取自 registry 声明（旧版取自 `preset.yml`）。
- 界面语言为 `en`（`/lang en`）时，内置 preset 显示本地化的英文名称与描述。
- 内置 preset：`standard` / `minimal` / `ptc`（旧版 `code`）/ `cordis` / `liangshen`；
  自定义 preset 原样显示。
- 空白会话可以原地切换。已产生对话的会话遵循官方 blank-only 规则：选择只
  保存为新默认值，在 `/new` 或下一次启动时生效。

### 默认值与优先级

- 默认值保存在 `~/.dsh-tui/agent-preset.json`。
- 优先级：`DSH_TUI_PRESET`（本次运行的显式指令）→ 持久化偏好 → 显式
  `config.preset`（部署默认值）→ 名册默认值 `standard`。
- 名册不再提供 `code` 时，旧偏好回退解析为 `ptc`，解析成功后迁移；rc 名册
  仍保留真实 `code` id，历史会话日志始终不改写。
- 恢复旧会话时，以该会话日志记录的 preset 为准，不读取当前默认值覆盖它。

### 梁神模式

- 梁神模式随 dsh-tui 包发布，0.1.7 启动时注册到官方 registry，已有同名 profile 声明优先。
- 旧版安装到用户 preset 根目录；已有非托管目录不会被覆盖。
- Windows 首轮 `bash` 通过自动发现的 Git Bash 执行，依次尝试：
  - PATH 上的 `git.exe` 所在安装树（安装器/便携/Scoop 布局通用，穿透 Scoop shim）
  - 常规安装位置与 Scoop 约定目录
  - PATH 上的裸 `bash`（最后兜底）
  - 始终拒绝把 System32 的 WSL 启动器当作 Git Bash
- 环境变量 `DSH_TUI_LIANGSHEN_BASH_PATH` 可显式指定 `bash.exe` 绝对路径。
- 设置后即为唯一候选；找不到即告警并跳过注册，首轮直接放开完整工具目录。

### Windows bash 工具（winbash）

`presets/winbash.mjs` 是随包分发的 Windows `bash` 工具插件，挂载在 host 层后
**对任意 Agent preset 生效**（与梁神模式无关、不进 `/preset` 名单）。行为对齐官方
`dsh-tool-bash`——官方 bash 执行器 `dsh-bash-local` 为 POSIX-only，Windows 不适用，故有此件。

- 每次调用在新 shell 中执行（`bash -c`），状态不跨调用保留；`description` 必填（UI 标题）。
- `run_in_background: true`：命令登记为后台 job，立即返回 job id；`job_output`/`job_kill`
  收集与停止，后台运行无超时。
- 前台命令到超时不杀：转后台继续跑并返回 job id（`promoteOnTimeout`，可配置关闭）。
- 非零退出以 `[exit code: N]` 标记报告，不算工具错误。
- 无 job registry 的组合自动降级为纯前台（超时即杀），不暴露 `run_in_background`。
- Git Bash 探测链与梁神模式相同（见上节）；环境变量 `DSH_TUI_WINBASH_BASH_PATH`
  （兼容旧名 `DSH_TUI_LIANGSHEN_BASH_PATH`）可显式指定 `bash.exe`。

挂载：把 `presets/winbash.mjs` 复制到 profile 根目录，在 `cordis.patch.yml`
的插件列表追加：

```yaml
- id: windows-bash
  name: './custom-bash.mjs'
  disabled: !!js process.platform !== 'win32'
```

配置项（挂载行的 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | `120000` | 前台默认超时（毫秒） |
| `maxTimeoutMs` | `600000` | 单次调用超时上限（带 job 时也是工具级硬顶） |
| `maxOutputBytes` | `64000` | 单流输出内存上限 |
| `enableRunInBackground` | `true` | 是否暴露后台参数（需 job registry 在场） |
| `promoteOnTimeout` | `true` | 前台超时是否转后台而非杀 |
| `bashPath` | — | 显式指定 `bash.exe`（同环境变量） |

> 与梁神模式内置的 `custom-bash` 注册同名工具 `bash`：同一 profile 只挂其一。
> 同时使用梁神 preset 时把本行 `disabled` 置 `true`（梁神内置那份为前台版）。

### 自定义 preset

0.1.7 通过 profile/bundle 声明 `@deepseek-ai/dsh-agent-preset`，配置包含 `id`、
`name` 与 `plugins`。旧目录预设需要按上游迁移为 bundle，TUI 不再自行扫描目录。
旧版仍从 `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml` 发现预设。

从 0.3 起，模型侧工具、plan、compaction、delegation 等由 preset 自己组合。
Profile 模式不再使用旧的 `DSH_TUI_COMPACT_RATIO`、`DSH_TUI_COMPACT_RETAIN`
或旧版 TUI 的深度限制；这些策略应在 preset 中配置。

## MCP

官方 `@deepseek-ai/dsh-mcp-client` 同时支持 stdio 与 streamable HTTP。
每个服务挂载后，工具以 `mcp__<server>__<tool>` 注册并自动进入模型工具集。

在用户 `cordis.patch.yml` 中插入：

```yaml
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: context7
        command: npx
        args: ['-y', '@upstash/context7-mcp']

    - id: mcp-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: remote
        url: https://example.com/mcp
        headers:
          Authorization: !!js process.env.MCP_TOKEN
```

运行 `/mcp` 查看已连接服务与工具数量。完整字段以
[DeepSeek Harness 配置目录](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog#deepseek-ai-dsh-mcp-client)
为准。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `VISUAL` / `EDITOR` | `Ctrl+G` 打开的外部编辑器（`VISUAL` 优先，可带参数如 `code --wait`；两者都未设置时提示配置，无 `vi` 兜底） |
| `DEEPSEEK_API_KEY` | DeepSeek 凭证；运行模型的必需项 |
| `DEEPSEEK_BASE_URL` | 覆盖 DeepSeek 兼容 API 端点 |
| `DSH_HOME` | harness 家目录（profile、会话、凭据、附件）；未设置时用上游默认 `~/.dsh` |
| `DSH_TUI_PERSONA` | 覆盖组合注入的 Agent persona |
| `DSH_TUI_PRESET` | 覆盖新会话默认 Agent preset |
| `DSH_TUI_THEME` | 锁定内置（`auto`/`light`/`dark`/`dark-ansi`）、静态主题或已注册的插件主题，优先于持久化选择 |
| `DSH_TUI_DISABLE_MOUSE` | 在 fullscreen 模式临时关闭鼠标处理 |
| `DSH_TUI_DISABLE_TERMINAL_IMAGES` | 设为 `1` 时强制关闭 Kitty/Sixel 探测、预览读取/解码与终端图片渲染，优先于 config 和 /settings；保留文字信息 |
| `DSH_TUI_IMAGE_PROTOCOL` | `auto`（默认）、`kitty`、`sixel` 或 `none`；覆盖协议选择，但不绕过图片预览偏好、禁用开关、非全屏、无障碍和多路复用器限制 |
| `DSH_TUI_RESUME_SESSION` | 启动时恢复指定会话，通常由启动器设置 |
| `DSH_TUI_RESUME_BACKEND` | `DSH_TUI_RESUME_SESSION` 的来源后端，只在启动器**派生**恢复目标时（裸 `--resume` 读该后端的上次会话、安全模式重试按最后运行记录）设置；boot 若落在别的后端（未装的 id 回落 `dsh`、没给 `DSH_TUI_BACKEND` 时跟随记住的内核），该目标一律**明确报错并非零退出**——不跨后端恢复、不静默冷启动、不新建会话（安全模式重试是唯一例外，降级为告警 + 冷启动）。用户显式给出的 id 不带此标记、原样透传 |
| `DSH_TUI_RESUME_RETRY` | 一次性标记：本次启动是安全模式的「重试正常启动」。重试的目标派生自最后运行记录，记录里的内核可能已经不在注册表里，所以带此标记的那次启动在恢复目标被撤销时降级为告警 + 冷启动，而不是报错退出。boot 读到即从 `process.env` 删除 |
| `DSH_TUI_BACKEND` | 会话后端（内置 `dsh` / `claude` / `codex`，或已装的插件后端），通常由 `dsh-tui --backend` 设置；未安装或写错的 id 按 `dsh` 启动并告警（若同时带了 `--resume` 请求则改为报错退出，见上） |
| `DSH_TUI_CLAUDE_PERMISSION_MODE` | Claude 后端的起始权限模式（`default`/`acceptEdits`/`plan`/`dontAsk`/`bypassPermissions`），优先于 `/permission` 记住的选择 |
| `DSH_TUI_WORKSPACE_TARGET` | 启动时解析的工作区路径或 URI，通常由 `dsh-tui <目标>` 设置 |
| `DSH_TUI_SESSION_ROOT` | 覆盖 JSONL 会话根目录；profile 默认 `$DSH_HOME/sessions`，裸 `cordis.yml` 默认 `~/.dsh-tui/sessions` |
| `DSH_PERMISSION_MODE` | 非 Windows 平台覆盖 sandbox policy，例如 `workspace-write` 或 `danger-full-access`；作为本次启动的初始权限面，优先于 `/permission` 记住的选择 |
| `DSH_TUI_WORKSPACE` | Windows `dsh-tui.cmd` 采用的工作目录 |
| `DSH_TUI_DEBUG` | 启用写往 stderr 的 dsh-tui 调试日志 |
| `DSH_TUI_RENDER_LOG` | 指定文件路径，记录原始 ANSI 渲染帧用于取证 |

旧名 `CC_TUI_*` 与 `DSH_CC_*` 来自早期版本命名，自本版本起不再被读取；环境变量
一律使用 `DSH_TUI_*` 前缀。

数据目录分两层，互不替代：

- **harness 家目录**：`$DSH_HOME`，未设置时用上游默认 `~/.dsh`。存 profile、
  会话、凭据与附件。早期版本把它钉在 `~/.dsh-cc`。
- **TUI 数据目录**：`~/.dsh-tui`（固定路径，不随 `$DSH_HOME` 走）。存 `/model`、
  `/lang`、`/theme` 等偏好与 `resume.txt`。早期版本曾把这些写在 `$DSH_HOME` 下。

`DSH_TUI_RENDER_LOG` 可能捕获屏幕上可见的提示词、工具参数和输出，不应上传到
公开 issue，除非已经检查并脱敏。

## `/provider`：运行时管理模型提供方

`/provider` 打开交互向导，无需重启即可添加、编辑、删除模型提供方。

- 来源：内置 catalog 路由或自定义 API 端点。
- 仅**用户配置层**写入的 provider 可编辑/删除；组合 base 继承来的不可删。
- 密钥写入 `~/.dsh/.credentials.yaml`（0600），界面只显示 `••••••`。
- 只有非环境变量来源的密钥才写库；与其他 provider 共用的密钥删除时保留。
- 编辑「模型列表」时会重新拉取候选：内置 catalog 路由先取安装目录快照，
  只要该路由存有 baseURL（或正在添加时填了端点），再用已存密钥实时探测
  `GET {baseURL}/models` 并合并——仅线上有的新模型标「线上新增」，勾选后
  写入其披露的容量字段；已有模型预勾选，只有显式取消勾选才会移除。无
  baseURL 的 catalog 路由只显示目录快照并在问题详情中注明。协议不唯一或
  配置了自定义请求头的 catalog 路由也会明确提示并回退到目录快照，不把线上
  新模型写入无法验证的 profile。
- 逐项菜单细节见[用户指南](user-guide.md)。

写入位置：

| 产物 | 位置 |
| --- | --- |
| provider profile | 0.1.7 当前 profile 配置中的 `llm-pi-ai.providers.<路由名>`；旧版在 `~/.dsh/settings.yaml`，写入即注册路由，删除即注销 |
| API key | `~/.dsh/.credentials.yaml`（0600），引用名为 `<路由名大写>_API_KEY` |

### 内置订阅 OAuth

标准 profile 的 `dsh-tui-auth` 行加载本包的 `./oauth` 入口，**不再依赖独立的
`dsh-auth` 插件包**。`/provider` 的添加分支提供 ChatGPT/Codex（`openai-codex`）、
Claude（`anthropic`）、Grok（`xai`）订阅账号登录。宿主 pi-ai catalog 提供相应流程
时还可使用 OpenAI 直连 ChatGPT 登录（`openai`，使用 OpenAI API 而非旧版 Codex
后端）和 Meta Muse（`meta`）。当前主验证线 DSH `0.2.0-rc.2` 携带 pi-ai
`0.87.1`，包含 Meta Muse，但不提供 OpenAI 直连登录。`/auth status`、`/auth login [provider]`、
`/auth logout <provider>` 对这些 pi-ai 路由操作同一套凭据。浏览器授权会尝试自动打开页面，并在同一
问卷中提供授权链接与手动粘贴回调 URL/代码的输入；设备码流程在轮询期间显示可复制的
短码。无交互问卷服务的宿主会明确拒绝登录。

`dsh-tui-auth` 行可配置 `providers`（默认安装版 pi-ai catalog 中所有受支持的流程；
显式指定时必须是其中的非空子集）、`credentialsFile`（自定义凭据文件）和
`modelOverrides.<provider>.<model>`（可选的 `contextWindow`、`maxTokens`）。
profile 覆盖的 `config` 是整段替换，覆盖时保留所需的每个字段。OAuth 流程使用宿主
`dsh-llm-pi-ai` 所带的 pi-ai 实现；这不是通用 API key 登录，订阅账号只走相应的
订阅后端。

默认凭据文件保持 `$DSH_HOME/dsh-auth/credentials.json`（未设置 `DSH_HOME` 时为
`~/.dsh/dsh-auth/credentials.json`），也可用 `DSH_AUTH_CREDENTIALS` 覆盖；旧版登录
无需迁移或重新登录。服务名 `ctx.dshAuth`、日志前缀 `dsh-auth` 也为兼容保留，
不代表仍需安装独立包。文件保存长期 refresh token，目录/文件尽力使用 0700/0600，
OpenAI 直连登录会按需在凭据文件同目录创建持久 UUID 文件 `device-id`（0600），供
pi-ai 作为当前安装的 agent-host ID。状态界面只展示登录与到期信息。登录后，模型才
出现在选择器中；同一 provider 若已由 `llm-pi-ai` 其他配置占用，OAuth 路由会拒绝
重复注册。

### DeepSeek 账号授权

DSH `0.2.0-rc.1+` 的 `dsh-base` 另有宿主拥有的 `deepseekAccount` 服务和
`deepseek-account` 模型路由。标准 profile 将它加入同一 `/provider` 账号登录分支、
`/auth status` 与 `/login` 状态列表；也可直接运行 `/auth login deepseek-account`，
成功后用 `/model` 选择 `deepseek-account` 下的模型。它与需要
`DEEPSEEK_API_KEY` 的 `deepseek-official` 是**不同路由**。`/auth logout deepseek-account`
调用宿主退登：先移除宿主凭据记录，远端撤销由宿主在后台处理。TUI 不复制 PKCE
协议、不读取账号 token，也不把账号凭据写入上述 `dsh-auth/credentials.json`。
DeepSeek 账号授权没有 pi-ai 的 token 到期/刷新时间；状态界面只显示已登录/未登录。
`dsh-tui-auth.config.providers` 和 `modelOverrides` 仍只控制 pi-ai 路由，
不用、也不能在其中填写 `deepseek-account`。

浏览器回调由宿主 `webServer` 服务提供。TUI-only profile 的
`dsh-tui-webserver` 行默认监听 `127.0.0.1` 的系统分配端口；与 Web 同时挂载时复用
官方 `webserver` 行，不打开第二个监听器。如果仅更新 profile，旧全局 TUI 补丁已有
`dsh-tui-auth` 但尚无 `dsh-tui-webserver` 行，内置 OAuth 入口会在首次 DeepSeek 登录时
按需挂载同一个官方宿主服务，监听 `127.0.0.1` 的系统分配端口；已有监听器仍会复用，
模块卸载时只清理自己挂载的兜底；已声明但禁用或启动失败的 webserver 行不会被绕过。
授权链接会尝试在浏览器打开，问卷同时显示完整链接和复制、重开、取消操作。
DeepSeek 流程必须经回调完成，**没有**手动粘贴授权码的回退。远程 SSH 使用本地浏览器时，
把 `dsh-tui-webserver` 的 `port` 覆盖为固定端口，并转发同一端口
（例如 `ssh -L 43123:127.0.0.1:43123 ...`）：

```yaml
- id: dsh-tui-webserver
  config:
    host: 127.0.0.1
    port: 43123
```

混合 Web profile 则覆盖官方 `webserver` 行。旧全局补丁没有该行时，固定端口覆盖
无法生效；SSH 用户仍需更新全局 TUI 包后再转发固定端口。回调监听器缺失或启动失败时，
登录会明确报错，其他 pi-ai OAuth 路由不受影响。

## 组合约束

- `user-interaction` 服务通常由 `dsh-base` 提供。本插件会在裸装时兜底创建，
  但 profile patch 不应重复插入。
- 自定义插入 subagent provider 时，核心 `subagent` 服务必须先挂载。
- 自定义覆盖 `plan-mode` 时，`section` 必须是非空文本。
- Profile 使用 base 的 JSONL 持久化并将根目录指向共享的 `~/.dsh/sessions`，
  因而 TUI 和 Web 可以读取同一份会话历史。
- `cordis.yml` 是裸组合示例，服务拓扑可能与 profile patch 不同。正常安装和用户
  覆盖应以 `cordis.patch.yml` 为准。

`DSH_TUI_SESSION_ROOT` 始终表示 JSONL 根目录。`dsh --profile dsh-tui` 默认使用
`$DSH_HOME/sessions`（通常为 `~/.dsh/sessions/`）；直接运行
`dsh --config cordis.yml` 的裸示例默认使用 `~/.dsh-tui/sessions/`。

权限相关配置与平台差异见[架构与限制](architecture.md#权限与安全边界)。
