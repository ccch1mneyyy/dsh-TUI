# 架构与限制

[文档索引](README.md) · [English](architecture.en.md)

## 运行链路

```text
Cordis profile
  -> src/index.ts（插件契约与 Schema）
  -> src/dsh-adapter/plugin.ts（服务、Agent、React 生命周期）
  -> DSH Agent / session / tool services
  -> src/dsh-adapter/channel.ts（session/event -> Channel）
  -> src/screens/Chat.tsx（键盘与模式编排）
  -> src/components/*（视图）
  -> src/ui.ts（主题化 renderer facade）
  -> src/ink/* + Yoga（布局、终端协议、差分输出）
  -> ANSI terminal
```

## 模块边界

| 模块 | 所有权 |
| --- | --- |
| `src/index.ts` | Cordis 插件名称、注入声明、配置接口与 Schema；保持入口轻量并延迟加载 runtime |
| `src/dsh-adapter/plugin.ts` | TTY 检查、服务装配、Agent 创建/恢复、React 挂载、统一退出清理 |
| `src/dsh-adapter/questions-answerer.ts` / `preset-resolution.ts` | user-questions 与 agent-preset 的预发布兼容分派；调用方不感知上游版本分支 |
| `src/dsh-adapter/channel.ts` | 将 DSH 持久化事件投影为 transcript；提供 submit、steer、resume、rewind、model/preset 等动作 |
| `src/workspaces.ts` | 本地路径 fallback 与通用工作区 provider registry；不得包含任何 provider 的协议、文案或依赖 |
| `src/screens/Chat.tsx` | modal 优先级、全局按键、滚动/搜索/选择状态、slash command 分发 |
| `src/components/` | 用户界面和 design-system；不直接拥有 Agent 或 session 真相 |
| `src/ui.ts` | 主题化 `Box`/`Text`、render、选择、滚动等公共 facade |
| `src/theme.ts`、`src/themeCatalog.ts` | 内置、静态 JSON 与运行时插件主题的解析和统一列表 |
| `src/dsh-adapter/themes.ts` | `ctx.tuiThemes` 主题插件接缝；注册生命周期与 host 私有 facade |
| `src/ink/` | 移植的 Ink renderer、终端协议、事件、选择与 Yoga 桥接；属于敏感底层设施 |
| `src/native-ts/yoga-layout/` | 纯 JS/TS 布局实现 |
| `cordis.patch.yml` | profile bundle 层；决定服务行、覆盖关系与挂载顺序 |

不要在组件中复制 DSH Agent、session 或 tool 服务。需要新能力时，优先通过已有
service、registry 或 channel seam 接入。

工作区扩展遵循单向依赖：TUI 只发布结构化 provider 接口，可选插件注册 URI、展示
信息和命令执行器。主题扩展同样只通过 `ctx.tuiThemes` 注册完整语义色板；宿主负责
校验、排序、渲染与生命周期，插件不能直接改写主题目录或宿主 palette。协议解析与
外部连接全部属于插件；删除插件后，本地工作区和会话路径不应出现缺失配置、占位文案
或降级分支。

## Session 是真源

`channel.ts` 不把 React 本地数组当作对话真相。DSH `session/event` 日志负责：

- 初始历史回放与增量流式事件；
- assistant/reasoning/tool 行的关联与 sequence anchor；
- rewind 的 turn 边界；
- resume、export、compact 和 fork 后的重建。

Channel 只保留适合当前 TUI 的投影。长会话超过窗口后，旧行会折叠为短预览；完整
内容仍在 session log 中，需要时从事件恢复。工具结果按 `callId` 关联，不能只按
数组位置猜测。

## 渲染与长会话性能

- **差分输出**：每帧只写屏幕变化，并使用终端能力探测决定同步输出、光标策略和
  Windows Terminal 兼容路径。
- **虚拟化消息列表**：屏幕外行使用上一次测量的固定高度占位，不参与完整子树布局。
- **回放合并**：历史回放时合并连续 token chunk，避免长流式消息触发二次字符串增长。
- **有界缓存**：transcript、渲染节点和测量缓存有上限；移除上限前必须有测量证据。
- **显示宽度**：ANSI、组合字符、emoji 和东亚宽字符都按 terminal cell width 处理，
  不能用普通 JavaScript `string.length` 代替。

改动 `src/ink/` 或 Yoga 时，至少运行 CI 的问卷/工具卡回归，并按影响范围运行
scroll、resize、copy-on-select 或 PTY 脚本。不要用普通 `console.log` 向活动 TUI 的
stdout 打印诊断；使用 stderr 的 `DSH_TUI_DEBUG` 或 `DSH_TUI_RENDER_LOG`。

## Inline 与 fullscreen

- **Inline（默认）**：内容留在主屏，终端模拟器管理 scrollback 和原生文本选区。
- **Fullscreen**：`AlternateScreen` 切换到备用屏，TUI 自己管理滚动、鼠标选区、OSC 52
  复制和退出时的屏幕恢复。

两种模式共享 Channel 与 React 视图，但终端协议路径不同。涉及输入、滚动、鼠标、
光标、resize 或清理的改动必须分别验证，尤其要覆盖窄终端和 Windows ConPTY。

## 持久化位置

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/sessions/` | profile patch 默认的共享 JSONL 会话事件（TUI / Web） |
| `~/.dsh-tui/sessions/` | 直接运行 `cordis.yml` 时的 JSONL 会话事件 |
| `~/.dsh-tui/resume.txt` | Windows 启动器和退出提示使用的最近 session ID |
| `~/.dsh-tui/last-used.json` | `/resume` 最近使用排序元数据 |
| `~/.dsh-tui/theme.json` | 当前主题选择（内置、静态或插件主题 ID） |
| `~/.dsh-tui/themes/` | 用户自定义主题 JSON；运行时插件主题不写入此目录 |
| `~/.dsh-tui/working-activity.json` | 工作状态动画选择 |
| `~/.dsh-tui/agent-preset.json` | 新会话默认 Agent preset |

`DSH_TUI_SESSION_ROOT` 在两种组合中都改写 JSONL 根目录。profile 默认使用
`$DSH_HOME/sessions`（通常为 `~/.dsh/sessions/`）；直接运行根目录的
`cordis.yml` 时默认使用 `~/.dsh-tui/sessions/`。偏好文件是可选状态：损坏或
缺失时回退，不应阻止 TUI 启动。

数据目录已从 `~/.dsh-cc` 更名为 `~/.dsh-tui`：首次启动时若旧目录存在而新目录
不存在，会整体复制（不移动）到新目录并提示一行，旧目录保留由用户自行删除。
`resume.txt` 例外：同时双写到新旧两个路径，因为旧版启动器只读旧路径。

## 权限与安全边界

`dsh-TUI` 本身不提供独立沙箱；实际能力由 `cordis.patch.yml` 挂载的 DSH 服务
决定。审批走 `ctx.approval` seam：策略为 `ask` 时 TUI 以 CC 式审批面板作为
answerer（`approval/request` waterfall），仅允许一次/拒绝两种决定——协议没有
"总是允许"与反馈通道；`/permission` 预设切换来自 dsh-base 的
`permission-presets` 服务行：

- 非 Windows 默认 `DSH_PERMISSION_MODE` 为 `workspace-write`，文件策略要求先观察
  文件，审批策略通常为 `ask`。
- Windows 当前没有可用的本地 sandbox 链，组合使用 `danger-full-access`，并将审批
  策略设为 `never`，以匹配终端信任模型。
- `DEEPSEEK_API_KEY` 只应来自环境变量或受控的运行时注入；状态命令只显示是否设置
  或脱敏片段。
- MCP、Shell、文件工具和自定义 preset 都会扩展模型可见能力，应当视为同一权限域
  内的代码执行入口。
- `/permission` 的可切换名册由已挂载的 DSH `permissionPresets` registry 提供，
  保持 registry 声明顺序；第三方预设会自动进入 picker，只有符合既有命令 token
  语法的 ID 进入 Tab 补全。`custom` 只作为 registry 投影出的当前态，不是目标。
- TUI 将服务状态区分为 runtime、legacy、unavailable：只有服务确实缺失时才保留
  旧三项 legacy 兼容；服务已挂载但损坏、空或数据不一致时 fail closed，不从
  sandbox/approval 组合猜测当前预设。所有切换仍调用官方 `/permission <preset>`。

在不可信仓库中运行前，检查实际 profile patch，而不是只看 TUI 的视觉界面。

## 已知限制

- 注入到 system prompt 的插件上下文不会在 UI 中单独列出，而是计入 system/context
  分段。
- `/model` 通过 session fork 切换，不是原位修改；旧会话会留在 `/resume`。
- `Ctrl+V` 读剪贴板按平台分派：Windows 用 PowerShell `Get-Clipboard`（剪贴板被
  其他程序锁定时重试后可能静默失败并显示为空）；macOS 用 `osascript`/`pbpaste`；
  Linux/Unix 按会话顺序尝试 `wl-paste`/`xclip`/`xsel`（工具缺失跳过、会话
  不可连接回退下一个，全部不可用时粘贴报"无可用剪贴板工具"）。剪贴板图片
  导出为临时文件插入路径（0700 私有目录、0600 文件），不内嵌图片块。
- 退出路径优先恢复终端并结束进程，不等待 Agent 异步落盘；持久化插件负责兜底。
- 工具级审批面板已实现（approval 服务 + TUI answerer）；`/permission` 的预设
  切换由 dsh-base 的 `permission-presets` 插件提供。registry 服务缺失时使用三项
  legacy 兼容名册；服务已挂载但空、损坏或不一致时标记 unavailable 并 fail closed，
  不伪造旧名册。若外部 `/permission` 命令未注册，输入沿用现有默认命令/model dispatch。
- `/vim`、`/connect`、`/hooks` 是兼容占位命令，不代表对应 DSH 能力已挂载。
- 没有一套需要真实模型凭证的自动化全流程测试；CI 使用 headless renderer 与假服务，
  真实模型集成仍需要在目标终端手动验证。

## 调试与验证

| 目的 | 方式 |
| --- | --- |
| 环境与 profile | TUI 内运行 `/doctor`、`/config`、`/permission status` |
| stderr 调试 | `DSH_TUI_DEBUG=1 dsh --profile dsh-tui` |
| 原始 ANSI 帧 | `DSH_TUI_RENDER_LOG=/path/to/render.log dsh --profile dsh-tui` |
| 主题回归 | `node --import tsx/esm scripts/verify-themes.mjs` |

`DSH_TUI_RENDER_LOG` 和会话导出可能包含敏感内容，分享前必须脱敏。
