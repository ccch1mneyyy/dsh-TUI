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
| `src/dsh-adapter/channel.ts` | Channel 组合根：options/services、owner/binding、specialist 接线、一次安装、最后启动/释放与兼容导出 |
| `src/workspaces.ts` | 本地路径 fallback 与通用工作区 provider registry；不得包含任何 provider 的协议、文案或依赖 |
| `src/screens/Chat.tsx` | modal 优先级、全局按键、滚动/搜索/选择状态、slash command 分发 |
| `src/components/` | 用户界面和 design-system；不直接拥有 Agent 或 session 真相 |
| `src/ui.ts` | 主题化 `Box`/`Text`、render、选择、滚动等公共 facade |
| `src/theme.ts`、`src/themeCatalog.ts` | 内置、静态 JSON 与运行时插件主题的解析和统一列表 |
| `src/dsh-adapter/themes.ts` | `ctx.tuiThemes` 主题插件接缝；注册生命周期与 host 私有 facade |
| `src/ink/` | 移植的 Ink renderer、终端协议、事件、选择与 Yoga 桥接；属于敏感底层设施 |
| `src/native-ts/yoga-layout/` | 纯 JS/TS 布局实现 |
| `cordis.patch.yml` | profile bundle 层；决定服务行、覆盖关系与挂载顺序 |

`channel.ts` 的职责分布在下列子模块：

- `channel/action-readiness.ts`：typed action forwarding/readiness。
- `channel/lifetime-resources.ts`：detached handles。
- `channel/context-bookkeeping.ts`：context warning/pending
  （包含压缩复位共用的 warning cell）。
- `channel/state.ts`：中性初始字段。
- `channel/command-completions.ts`：补全。
- `channel/local-actions.ts`：本地 transcript/shell/子代理报告动作。
- `channel/activity.ts`：工作状态时钟。
- `channel/binding-events.ts`：绑定事件路由。
- `channel/projection.ts`：唯一 projector 仍在。

未安装或已释放的动作明确失败，不伪装为成功 no-op。

不要在组件中复制 DSH Agent、session 或 tool 服务。需要新能力时，优先通过已有
service、registry 或 channel seam 接入。

工作区扩展遵循单向依赖：TUI 只发布结构化 provider 接口，可选插件注册 URI、
展示信息和命令执行器。

主题扩展同样只通过 `ctx.tuiThemes` 注册完整语义色板。宿主负责校验、排序、
渲染与生命周期；插件不能直接改写主题目录或宿主 palette。

协议解析与外部连接全部属于插件。删除插件后，本地工作区和会话路径不应出现
缺失配置、占位文案或降级分支。

## Session 是真源

`dsh-adapter/channel.ts` 不把 React 本地数组当作对话真相。
DSH `session/event` 日志负责：

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
- **零分配热路径**：visibleRows 管线按 rows 身份、长度与 Uint8Array
  流式位指纹记忆化，每个滚动 tick 零数组/Map 分配。
- **全局 LRU 缓存**：wrapText 与 markdown token 走全局 LRU 缓存跨挂载复用。
- **分帧回填**：主屏先挂尾部窗口再分帧回填历史。
- **落位锚点**：`/resume` 保证最新消息最后一行可见可达，长会话恢复跳过
  开屏动画直落内容。
- **显示宽度**：ANSI、组合字符、emoji 和东亚宽字符都按 terminal cell width 处理，
  不能用普通 JavaScript `string.length` 代替。

改动 `src/ink/` 或 Yoga 时，至少运行 CI 的问卷/工具卡回归，并按影响范围运行
scroll、resize、copy-on-select 或 PTY 脚本。不要用普通 `console.log` 向活动 TUI 的
stdout 打印诊断；使用 stderr 的 `DSH_TUI_DEBUG` 或 `DSH_TUI_RENDER_LOG`。

## 图片渲染预算

这些是内部预算，用户操作见[交互与命令](interaction.md)。

- 大图预览外框以对话区约 95% 宽高为预算，图片保持等比。
- 预览打开期间，卡片以外的对话区内容变淡。
  - 带明确颜色的前景与背景（像素画、工具卡、语法高亮）向终端底色混合一半。
  - 终端底色按 OSC 11 探测；未探测到时按主题明暗取黑或白。
  - 无色文字用终端的 faint 属性。
  - 卡片本身、输入栏与状态行不变，关闭后恢复。
- 卡片至少与标题同宽，小图不会挤掉文件名，标题超过对话区宽度时先在文件名中间省略。
- 全屏且 Kitty graphics 或 Sixel 探测成功时显示有界、等比的缩略图。
- inline、辅助功能模式、多路复用器或读取失败时占用相同布局并显示文字回退。
- Sixel 缩略图随会话滚动并按可见区域裁剪，不缩放挤入剩余行，也不覆盖输入栏。
- 打开大图预览时撤下背景缩略图，关闭后从缓存恢复；普通文字更新不重复传输未变化的图片。
- 解码与传输有并发、缓存和字节预算，超限或失败时保留文字回退。
- 仅在可绘制图片时读取和解码可见消息的附件；其余情况直接使用元数据，不加载解码器。
- 大图预览的解码与 Sixel 栅格最长边可达 2048 像素，同时限制在约 210 万像素（8 MiB RGBA）以内。
- 方图会受总像素数约束，不会直接生成 2048×2048 的大栅格。
- 缩略图仍按 384 像素解码。
- 普通插件图片的 1024 像素/4 MiB 限制、整帧 16 MiB 及 Sixel 单次编码 4 MiB 预算保持不变。
- 局部查看从原始附件裁剪，放大采用最近邻。
- 超过像素预算时缩小可见区域而不是缩小原像素。
- 连续平移合并请求，过期结果不会覆盖新位置。
- 每次查看保留一份编码原图（最多 64 MiB），解码输入最多 6400 万像素。
- 不在 JS 中缓存整张原尺寸 RGBA；某些格式仍需要解码器扫描原文件。
- Sixel 的 256 色量化依然存在，100% 指空间像素比例，不代表无损颜色。

## 状态仪表与工作状态

- **上下文进度条**：基于 pi-nano-context 算法（最大余数分段着色 + 多级紧凑读数）。
- **TPS 仪表**：基于 pi-tps-meter——流式 1/8 块仪表、历史 min-max 火花线、
  按速度语义着色（≥50 绿 / ≥20 黄 / <20 红）。
- **working-activity**：工作状态行复用
  [dsh-working-activity](https://github.com/ccch1mneyyy/working-activity)
  的纯状态机。
- 进程内从基础会话事件推导，不把 UI 状态写进共享日志。

## Inline 与 fullscreen

- **Inline**：内容留在主屏，终端模拟器管理 scrollback 和原生文本选区
  （出厂默认是 fullscreen，见下）。
- **Fullscreen**：`AlternateScreen` 切换到备用屏，TUI 自己管理滚动、
  鼠标选区、OSC 52 复制和退出时的屏幕恢复。

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
`cordis.yml` 时默认使用 `~/.dsh-tui/sessions/`。

偏好文件是可选状态：损坏或缺失时回退，不应阻止 TUI 启动。

数据目录为 `~/.dsh-tui`（早期版本曾用 `~/.dsh-cc`，自更名版本起新代码只读写
`~/.dsh-tui`，不自动迁移旧目录）。

## 与 VS Code 扩展的通道细节

companion 扩展 `dsh-tui-vscode` 与 TUI 的交互面，维护 dsh-tui 侧时需要了解：

- **指定会话恢复（env 通道）**：点侧边栏会话条目时，扩展把目标会话 id 经
  `DSH_TUI_RESUME_SESSION` 注入终端环境，并刻意不传 `--resume`。本 profile 的
  `cordis.patch.yml` 启动时读该 env（`sessionId: !!js
  process.env.DSH_TUI_RESUME_SESSION ?? undefined`），TUI 随即恢复该会话。
  若传裸 `--resume`（或 `-c`/`--continue`），启动器（`bin/dsh-tui.js`）会用
  `~/.dsh-tui/resume.txt` 覆盖 env——那是「恢复上次会话」的路径，两者互不干扰
  （已读启动器源码确认）。CLI 用户也可用 `dsh-tui --resume <id>` 或
  `--resume=<id>`（0.7.0 起）恢复指定会话，效果与 env 通道一致。
- **侧边栏会话历史的数据源**：`~/.dsh/sessions` 的会话日志（zstd JSONL）、
  dsh-storage 账本（`~/.dsh/storages/session_projcache.json`，Web 会话列表的
  标题来源）、TUI 的最近使用表（`~/.dsh-tui/last-used.json`）。标题优先级：
  日志 `session/title` 事件 → storage 账本标题 → 首条用户消息 → "未命名会话"；
  完整路径与会话 id 进悬浮提示。按项目（cwd 短名）分组、按最近活跃/使用排序；
  自动刷新监听会话目录变化。

## 权限与安全边界

`dsh-TUI` 本身不提供独立沙箱；实际能力由 `cordis.patch.yml` 挂载的
DSH 服务决定。

审批走 `ctx.approval` seam：策略为 `ask` 时，TUI 以本地审批面板作为
answerer（`approval/request` waterfall），仅允许一次/拒绝两种决定——
协议没有"总是允许"与反馈通道。

`/permission` 预设切换来自 dsh-base 的 `permission-presets` 服务行：

- 非 Windows 默认 `DSH_PERMISSION_MODE` 为 `workspace-write`，文件策略要求先观察
  文件，审批策略通常为 `ask`。
- Windows 当前没有可用的本地 sandbox 链，组合使用 `danger-full-access`，并将审批
  策略设为 `never`，以匹配终端信任模型。
- `DEEPSEEK_API_KEY` 只应来自环境变量或受控的运行时注入；状态命令只显示是否设置
  或脱敏片段。
- MCP、Shell、文件工具和自定义 preset 都会扩展模型可见能力，应当视为同一权限域
  内的代码执行入口。
- `/permission` 的可切换名册由已挂载的 DSH `permissionPresets` registry
  提供，保持 registry 声明顺序。
- 第三方预设自动进入 picker、Tab 补全与 `Shift+Tab` 循环（排除
  `custom`/`status`、canonical 预设、重复 identity 与不安全 token）。
- 首次观察遵循 registry 顺序，后续刷新保留已见 identity 的相对顺序。
- `custom` 只作为 registry 投影出的当前态，不是目标。
- 服务快照可用时 `/permission` 由 TUI 本地接管（菜单常驻项）。
- 切换**优先**调用官方 `/permission <preset>` 命令。
- 命令行未暴露给本 agent（组合相关）时，**回退**到 permissionPresets
  服务的官方写路径 `set(session, preset)`——与命令 handler 同一实现，
  写真实 `permission/preset`/`sandbox/mode`/`approval/policy` 事件。
- TUI 绝不伪造事件，随后按事件/读回确认。
- 两条路都不可用时显式 toast + 日志，**绝不**把命令当普通消息发给模型。
- 退出计划模式先恢复进入前的 atom，再还原进入前的持久预设身份
  （registry 仍提供该身份时）。
- TUI 将服务状态区分为 runtime、legacy、unavailable：只有服务确实缺失时
  才保留旧三项 legacy 兼容。
- 服务已挂载但损坏、空或数据不一致时 fail closed，不从 sandbox/approval
  组合猜测当前预设。
- 适配器按真实服务契约读取 `current(session)`（session-projection），
  并兼容旧的事件日志形态。

在不可信仓库中运行前，检查实际 profile patch，而不是只看 TUI 的视觉界面。

## 已知限制

- 注入到 system prompt 的插件上下文不会在 UI 中单独列出，而是计入 system/context
  分段。
- `/model` 通过 session fork 切换，不是原位修改；旧会话会留在 `/resume`。
- `Ctrl+V` 读剪贴板按平台分派：
  - Windows 用 PowerShell `Get-Clipboard`（剪贴板被其他程序锁定时重试后
    可能静默失败并显示为空）。
  - macOS 用 `osascript`/`pbpaste`。
  - Linux/Unix 按会话顺序尝试 `wl-paste`/`xclip`/`xsel`（工具缺失跳过、
    会话不可连接回退下一个，全部不可用时粘贴报"无可用剪贴板工具"）。
- 受支持的剪贴板图片：先导出到 0700 私有目录中的 0600 临时文件，再写入
  Harness 附件库并在输入框显示 `[Image #N]`；临时导出随后删除，输入文本
  不含路径或 base64。
- 不支持的位图格式：明确警告并删除临时文件。
- 附件服务不可用时：不把位图插入草稿。
- 文件管理器复制的图片文件若直接暂存失败，仍可退回 `@` 引用。
- 退出路径优先恢复终端并结束进程，不等待 Agent 异步落盘；持久化插件负责兜底。
- **后台会话活在本进程内**：TUI 退出即停止；状态与行摘要来自会话自身输出、
  无额外摘要模型调用；worktree 隔离尚未提供。
- 工具级审批面板已实现（approval 服务 + TUI answerer）；`/permission` 的
  预设切换由 dsh-base 的 `permission-presets` 插件提供。
- registry 服务缺失时使用三项 legacy 兼容名册；服务已挂载但空、损坏或
  不一致时标记 unavailable 并 fail closed，不伪造旧名册。
- 若外部 `/permission` 命令未注册，输入沿用现有默认命令/model dispatch。
- `/vim`、`/connect`、`/hooks` 是兼容占位命令，不代表对应 DSH 能力已挂载。
- 没有一套需要真实模型凭证的自动化全流程测试；CI 使用 headless renderer
  与假服务。
- 本 L4 批次也**尚未**在真实 TTY 的 inline/fullscreen、窄终端或 Windows
  ConPTY 手动演练；真实模型集成仍需要在目标终端手动验证。L5 完整 RFC
  state 本轮 Deferred。
- L4 已完成本地独立集中审查与定向修复；最终 compile、build/package 门禁、Channel UI
  58/58 和 CI3 通过。这些结果不代表真实 TTY 或长期内存压力测试通过。

## 调试与验证

| 目的 | 方式 |
| --- | --- |
| 环境与 profile | TUI 内运行 `/doctor`、`/config`、`/permission status` |
| stderr 调试 | `DSH_TUI_DEBUG=1 dsh --profile dsh-tui` |
| 原始 ANSI 帧 | `DSH_TUI_RENDER_LOG=/path/to/render.log dsh --profile dsh-tui` |
| 主题回归 | `node --import tsx/esm scripts/verify-themes.mjs` |

`DSH_TUI_RENDER_LOG` 和会话导出可能包含敏感内容，分享前必须脱敏。
