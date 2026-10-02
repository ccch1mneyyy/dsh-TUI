
<p align="center">
  <img src="docs/assets/readme/logo.svg" alt="dsh-TUI 像素鲸鱼标题动画" width="560">
</p>
<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm" src="https://img.shields.io/npm/v/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ccch1mneyyy/dsh-TUI?style=flat-square&color=4b6fff"></a>
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <img alt="官方收录" src="https://img.shields.io/badge/DeepSeek%20Harness%20官方公众号-收录-brightgreen">
</p>

# dsh-TUI

> 面向 DeepSeek Harness 的交互式终端界面插件：像素鲸鱼顶栏、实时工作状态、流式思考展示、双击 Esc 时间回溯、上下文进度条与 TPS 仪表。
> 零核心改动，纯插件挂载。安装即启用，卸载不留核心补丁。

## 功能亮点

- **像素鲸鱼娘** — 开屏三选一动画，点击唤醒；开始第一个任务后定格。
- **落地页与首次引导** — 每次启动先落在带**真输入框**的落地页（大字 + 鲸鱼 + 快捷入口，窄/矮终端自动整块降级）；首次运行走四步向导（API Key / 语言主题 / 模型工作区 / 快捷键），`/setup` 随时重跑。
- **终端原生界面** — 流式 Markdown、工具卡、`/` 与 `@` 补全、`#L12-14` 行区间、历史搜索、中英界面。
- **图片** — Kitty/Sixel 缩略图，居中大图可缩放平移，粘贴前按限额适配，无图形时文字回退。
- **Mermaid 图表** — ```` ```mermaid ```` 代码块画成 Unicode 字符图。
- **LaTeX 公式** — `$…$` 与 `$$…$$` 公式转成 Unicode 文本，块级公式里的分数与上下限竖排；`mathRendering: image` 时在支持图形的终端里把块级公式与能压成一行的行内公式排成终端图片。
- **时间轴** — 全部回合可点；右栏时间线 / 滚动条 / 隐藏。
- **侧栏面板** — `Ctrl+B` 在聊天右侧展开面板列（待办 / 任务），终端够宽才分栏；窄屏与 inline 模式保持整屏面板。
- **实时状态** — 工作动画、上下文条、TPS、缓存命中率、推理强度、token、本会话费用估算（主会话 + 子代理）、Git 与会话信息。
- **唯一的会话管理界面** — `/resume` `/home` `/agentview` `/bg` `⌸`。
- **会话工作流** — `/new` `/compact` `/export` `/btw`、模型热切换、fork、回溯、vim、全屏草稿编辑器。
- **IDE 选区通道** — VS Code 里选中的代码进 prompt。
- **DSH 集成** — presets、技能、MCP、目标、待办、子代理、问卷。
- **账号登录** — 标准 profile 提供 pi-ai 的 ChatGPT/Codex、Claude、Grok OAuth（可用时还有 OpenAI 直连与 Meta Muse）；DSH 0.2.0-rc.1+ 还通过宿主服务提供 DeepSeek 浏览器登录，路由为 `deepseek-account`。通过 `/provider` 或 `/auth` 使用，无需另装插件。
  仅更新 profile 而留下已挂载 `dsh-tui-auth` 的旧全局 TUI 补丁时，本地登录也会按需启动官方 loopback 回调监听器；SSH 固定端口转发仍需对齐全局安装包。
- **扩展** — 浏览器交互、computer use 等。
- **为长会话设计** — 事件驱动投影、虚拟化、有界缓存。

键位与命令：[交互与命令](docs/interaction.md)。其余见[文档索引](docs/README.md)。

## 界面预览

<div align="center">
  <picture>
    <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-zh-mobile.svg">
    <img src="docs/assets/readme/preview-zh.svg" alt="dsh-TUI 会话录制：欢迎界面、补全、帮助与输入，以及像素鲸鱼动画。" width="78%">
  </picture>
</div>

## 官方收录

**DeepSeek Harness 官方负责人**推荐的社区插件中，dsh-TUI 是首个被推荐的插件。

本插件被 **DeepSeek Harness 官方公众号**推文收录，也被 [dshfind](https://dshfind.com/ccch1mneyyy/dsh-TUI) 插件目录收录，并登上 [GitHub Trending](https://trendshift.io/repositories/146168) 日榜第七（TypeScript 口径）。

<div align="center">
  <table>
    <tr>
      <td align="center" valign="middle" width="50%">
        <img src="screenshots/wechat-official.png" alt="DeepSeek Harness 官方公众号推文收录 dsh-TUI" width="480">
        <br>
        <strong>DeepSeek Harness 官方公众号推文收录</strong>
      </td>
      <td align="center" valign="middle" width="50%">
        <a href="https://dshfind.com/ccch1mneyyy/dsh-TUI"><img src="https://dshfind.com/api/card/ccch1mneyyy/dsh-TUI?lang=zh" alt="dsh-TUI on dshfind" width="420"></a>
        <br>
        <strong>dshfind 插件目录收录</strong>
        <br><br>
        <a href="https://trendshift.io/repositories/146168" title="GitHub Trending 日榜 #7 · TypeScript 口径"><img alt="Trendshift" src="https://trendshift.io/api/badge/trendshift/repositories/146168/daily?language=TypeScript"></a>
         <br>
        <strong>GitHub Trending 日榜第七</strong>
      </td>
    </tr>
  </table>
</div>

## 快速开始

前置条件：安装 [Node.js](https://nodejs.org/zh-cn) 与 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。`deepseek-official` API key 路由需要 `DEEPSEEK_API_KEY`；DSH 0.2.0-rc.1+ 的标准 profile 也可用 `/auth login deepseek-account` 登录，再通过 `/model` 选择独立的账号路由。其他支持的账号可在启动后通过 `/provider` 或 `/auth` 登录。

主适配目标为 DSH `0.2.0-rc.2`，已接入新版 Shell API、V4 会话消息、声明式预设与
profile 设置；旧受支持版本保留兼容路径。迁移说明见[配置参考](docs/configuration.md)。

DSH 0.1.7 的 `/settings` 使用 TUI 实际的 Loader 行 ID，也支持自定义 ID。
profile 依赖须配套，包含 `@deepseek-ai/schemastery` 3.18.3 或更新版本；
Schema 不兼容时，TUI 在启动阶段报错并提示修复安装，不再显示不可编辑的设置页。
旧 host 继续使用原有设置 scope。

```sh
# 安装（全局，自带 dsh-tui 命令）
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# 启动（首次运行自动初始化 profile，需要 pnpm）
dsh-tui
# dst 是短别名，启动同一个 TUI
dst
```

手动安装：跑仓库根目录的 `install.sh`，或 `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`。之后 `dsh-tui` 与 `dsh --profile dsh-tui` 等价。

> **新用户提示**：pnpm ≥11 默认拦截带安装脚本的依赖，报 `ERR_PNPM_IGNORED_BUILDS`。更新时还会忽略异平台的 `@img/sharp-*` 原生包，省约 200MB 下载。`/update` 与 `dsh-tui update` 都会自动写好这两份配置，无需手工处理。细节见[安装与快速开始](docs/getting-started.md#pnpm-安装脚本拦截与异平台原生包)。

TUI 启动后会在后台检查新版本，不阻塞首帧。有更新时输入 `/update` 一键升级，自动重启并恢复当前会话。profile 叠加机制、源码构建与常见问题见[安装与快速开始](docs/getting-started.md)。

### CLI 子命令

| 命令 | 作用 |
| --- | --- |
| `dsh-tui` / `dst` | 启动 TUI；短别名是同一个程序 |
| `dsh-tui --resume [id]` · `dsh-tui update` · `dsh-tui doctor` | 恢复会话 · 更新 profile 并对齐启动器 · 环境体检 |
| `dsh-tui safe` | 只读诊断、插件清单与修复指引；`safe --rescue` 创建干净的救援 profile |
| `dsh-tui version` · `dsh-tui help` | 启动器与 profile 版本、用法；没装 dsh 时这两条也能用 |

前置 DSH 选项（如 `--dump-config`、`--patch <路径>`）原样转发，
其余参数交给 `dsh --profile dsh-tui` 中的应用。使用
`dsh-tui -- --resume=sid-1 ./notes` 可将 `--resume=sid-1 ./notes` 作为字面提示词，
不选择恢复会话或工作区。直接调用 DSH 时，使用
`dsh --profile dsh-tui -- -- --resume=sid-1 ./notes`：第一个 `--` 属于 DSH，
第二个属于应用。宿主选项可以放在字面提示词之前：
`dsh-tui --patch ./overlay.yml -- --resume=sid-1` 会应用补丁，
并将 `--resume=sid-1` 作为提示词发送，而不恢复该会话。
安全模式：[安装与快速开始](docs/getting-started.md)。

### 迁移其他编程代理的对话（`dsh-tui migrate`）

把 Claude Code、Codex、OMP、zcode、Grok Build 的本地对话历史导入 DSH 会话库，之后用 `/resume` 按原工作目录浏览与恢复：

```sh
dsh-tui migrate                # 列出各代理可迁移的对话数量（不写入）
dsh-tui migrate claude-code    # 导入 Claude Code 的全部对话（codex / omp / zcode / grok-build 同理）
dsh-tui migrate codex --dry-run  # 只预览将落盘的内容，不写入
```

- **只读源**：迁移只读取源代理的本地存储，绝不修改；产物经官方 `JsonlSessionPersistence` 后端写入 `$DSH_HOME/sessions`——导入的会话是一等公民（可打开、可续聊）
- **幂等**：同一源对话命中同一确定性 UUID——重复导入跳过已存在项，不堆叠重复
- **保留结构**：按轮次还原用户/助手消息、思考过程（reasoning）、工具调用及其结果，以及源里的上下文压缩（写为原生压缩检查点）；harness 注入的机器文本不开轮。导入的会话可以直接接着做事
TUI 内浏览：会话管理界面（`/resume`）为每个有会话的代理显示一个标签，选中一条即只导入这一条并直接打开。
TUI 内：`/migrate`（或 `/migrate <agent> [--dry-run]`）以子进程运行同一导入，经通知流汇报，不卡界面。
CLI 形态：任意终端运行 `dsh-tui migrate ...`，与 TUI 内执行同一套导入。
完整指南：[会话迁移](docs/migrate.md)。

- pi / opencode 等其他代理经 adapter 注册表逐步扩展；grok-build 支持读 `GROK_HOME` 环境变量

**VS Code**：用集成终端，或用 `dsh-tui-vscode` 扩展。见 [VS Code 使用指南](docs/vscode.md)。**Herdr**：在 [Herdr](https://herdr.dev) 窗格运行 `dsh-tui`，经其本地集成 API 报告 `idle` / `working` / `blocked`。

## 快捷键与鼠标

`Enter` 发送 · `Tab` 补全 · `Ctrl+Enter` 打断并发送 · `Alt+Up` 取回上一条 · `Esc` 逐层关闭，空输入双击回溯 · `Ctrl+B` 侧栏 · `Ctrl+O` 详情 · `Ctrl+R` 搜历史（`↑`/`↓` 与 `Ctrl+R` 按当前项目隔离） · `Ctrl+V` 粘贴 · `Ctrl+Shift+E` 全屏草稿编辑器 · `?` 快捷键 · `←` 转后台。

模型工作时：`Enter` 加塞、`Tab` 排队、`Ctrl+Enter` 打断并立即发送。

原生 Windows 下，分片的 Win32 输入记录会跨短暂输入延迟重组，不再作为数字协议串进入输入框。平台检测只能说明这台机器可能运行该私有模式（win32-input-mode）：裸 `ESC[` 分片只有在真正解码到一条记录之后才会被扣住，而自身形状已足够像一条记录的分片可自行挂起（这也是首条记录即使被切分仍可能恢复的原因）。从不进入该模式的 Windows 终端（mintty、GitBash 等）因此保持经典 VT 路径：单独 `Esc` 保持既有响应时间，`ESC[` 超时释放后紧随输入的字母也不会被吞掉。

半包恢复窗口有界（自首次捕获起 1 秒，不因后续输入续期；上限 64 字节），超过任一边界后挂起结束、按既有方式处理。未识别的完整 CSI 序列不会作为正文插入；损坏的 CSI 前缀之后，裸 ASCII 字母可能被当作终止符消费，正常 Win32 按键记录与括号粘贴文本仍按各自边界处理。

会话的首条记录若在记录自身形状成形前被切分，仍可能残留；一旦解码到任意一条记录，所有切分位置都会被覆盖。在恢复窗口内，以 `[数字;…` 开头的字面输入与协议前缀无法区分：可能被短暂扣住，或被拼到先前的 `Esc` 之后。如需输入该形态，可先等窗口结束，或避免紧接 `Esc` 后立即输入。

终端应答被拆包到达时也按同样方式重组（常见来源是原生 Windows 的 ConPTY）：在应用仍有查询等待答复期间，未完成的 DA1 / DA2 / DSR / DECRPM / XTVERSION 尾巴（包括介绍符 `Esc` 已被 flush 后再次被切分的尾巴）会跨输入延迟被扣住，但仅限其形状仍可能补全为该查询期望的应答类型时。补全后按应答消费，而不是作为协议文本进入输入框。

这条认领有证据门控，也正是与既有版本的差异所在：没有查询在等待答复时不会认领，紧接 `Esc` 之后打出的字面 `[?61;4c` 照常进入输入框。

窗口同样有界（约 1 秒，不因后续输入续期；上限 64 字节）；超过任一边界后挂起结束，仍呈未完成应答前缀形状的字节按丢弃处理，不会作为正文显示。

窗口内且确有匹配应答类型的查询在途时，同形状的字面输入仍有被认领为应答的可能；要输入这类文本，可等窗口结束（约 1 秒）后再打，或避免在查询未答复期间输入该形状。

终端以 SGR 形式上报鼠标时，同一条上报可能被拆到多次读取到达：不完整的头片段会先被扣住，不再作为文本落进输入框；补齐后按鼠标事件处理。该行为只在鼠标上报确实开启（全屏且启用鼠标追踪）时生效；inline 会话与从未开启追踪的终端保持既有行为不变。认领窗口自首次扣住起有界（最坏 1 秒、最多 64 字节），窗口内到达的续包仍会被认领；释放不依赖定时器——某次解析调用越过任一边界时，会按到达顺序把扣住的字节当普通按键原样回放，字面输入只会延迟，不会被丢弃。

鼠标（全屏）：拖选即复制、双击/三击选词选行、点工具卡、时间轴刻度与 `[Image #N]` 预览。

正文中的文件路径可打开文件操作菜单；自动识别不会从 `working/idle/needs-input` 这类斜杠分隔的词串或 `2024/01/15` 这类日期内部截出路径。

**粘贴**：终端原生与 bracketed paste 保留普通文本与换行，粘贴内容到达时不会被误当 `Enter` 提交。Windows 终端以 win32-input-mode 键记录投递粘贴时，记录残留会在入口被整体剥离（多行粘贴不再留下零散 `_`），粘贴的 CRLF 折叠为单个换行；普通文本中的真实下划线与 bracketed paste 内容不受影响。

**拖放文件**：原生 Windows 的桌面拖放（Windows Terminal / OpenConsole）以 OSC 8 超链接到达；解析器在粘贴载荷卫生之前把其中的 `file://` URI 还原为解码后的本地路径，`]8;id=…;` 参数残渣不会进入草稿。图片路径进入既有图片 stage 管线；其他文件作为可引用路径插入（含空白路径以 composer 的单 token 引号形式 `"…"` 到达）。只还原 `file://` URI 且 fail-closed：远程 authority/UNC、一个载荷里带多个不同 URI、或带多个 token 的 URI 一律拒绝并保持字面文本，不做猜测。

完整参考：[交互与命令](docs/interaction.md)。

## 内置命令

`/resume` · `/home` · `/agentview` · `/bg` · `⌸` 打开同一个会话管理界面：工作区栏、实时状态、筛选、★ 固定。另有 `/model` `/new` `/compact` `/export` `/btw` `/tree` `/fork` `/rewind` `/settings` `/setup` `/status` `/cost` `/jobs` `/skills` `/mcp` `/provider` `/auth` `/login` `/update`。

会话管理界面会立即显示上次成功读取的列表，同时核对持久化存储的变化。需要深度扫描日志的标题会先显示回退名称，恢复完成后在原行更新。
移除工作区登记后，其历史会话仍可从侧栏的「仅历史」目录进入。
「仅历史」目录只提供编辑和新建会话操作；重命名与移除仅适用于已登记工作区。

**后台会话**：`/bg` 或空输入按 `←`；按 `Esc` 回到它。跑在本进程内，TUI 退出即停止，日志保留。

完整命令：[交互与命令](docs/interaction.md)。

## 配置与扩展

Agent 预设、主题、MCP 服务器、环境变量：[配置参考](docs/configuration.md) · [主题系统](docs/themes.md)。

## 工作原理

```text
dsh profile → dsh-base → dsh-TUI Cordis patch → agent preset + DSH services
  → session/event → Channel projection → React components → Ink/Yoga renderer → terminal
```

TUI 只负责交互与呈现：会话日志是唯一事实源，模型、工具与持久化归 DSH 服务。长会话单帧成本 O（可见窗口）。

运行链路、模块边界、性能要点与持久化位置见[架构与限制](docs/architecture.md)。

## 已知限制

- 注入的插件上下文没有独立展示，计入上下文分段。
- `/model` 靠 fork 切换会话；旧会话留在 `/resume`（还没人说过话的会话不记分支，换完模型第一个 prompt 仍能自动生成标题）。
- `Ctrl+V` 需要平台剪贴板工具；不支持的位图格式直接拒绝。
- 拖放文件仅从 OSC 8 的 `file://` URI 还原：多文件拖放、非 Windows 终端的拖放编码与无终止符的截断帧仍不在覆盖范围，超链接自身的显示名也不会被使用。
- 后台会话活在本进程内，TUI 退出即停止。
- `/thinking` 不持久化；内核 `minimal` 预设（极简模式，只暴露一个持久 shell 工具）不挂载压缩服务，也不剪枝工具结果——长会话可能撞上下文上限，超长工具输出会整段留在上下文里，`/compact` 与问卷在该预设下不可用（Help 与 `/` 补全会标注「不可用」，进入该预设时也会提示一次）；它和 `/settings → 极简界面`（Minimal UI）这个界面显示开关不是一回事；`/update` 需 `dsh --profile` 启动，回合运行中会被拒绝。
- 状态栏 `≈¥` 与 `/cost` 是本会话估算：包含子代理用量，按各自模型 × 峰值/空闲 × 缓存分项计价；非官方/未收录模型只显示 token 并标注未计价。**估算仅供参考，以平台账单为准。**
- 分片的 SGR 鼠标上报只在机制层修复并做了受控夹具对照；报告者的原环境（macOS→SSH、WSL2 + `dsh web`）未复测。

完整清单见[架构与限制](docs/architecture.md)。

## 开发

CI 使用 Node 24 与 pnpm 11，本包支持 Node `^22.19 || >=24`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`lib/types/` 是被忽略的生成物。`pnpm build` 从干净输出目录重编译，并跑构建门禁。**不支持 Git URL 安装**。源码 manifest 把 `@dsh-std/*` 保留为 workspace 依赖，`vendor/dsh-std` 是子模块，pnpm ≥11 还默认拒绝 git 托管的 `prepare` 脚本。请安装 registry 包：`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`。渲染、问卷或工具卡改动还需对应的回归脚本。

## 插件生态

插件开发：[准入与开发指南](tui-profile/docs/plugin-admission-and-development.md) · [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template) · [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)。参考实现：`dsh-working-activity`。

接缝分级与 API 说明：[插件开发](docs/plugins.md)。生态组织只维护收录，不背书社区插件。

## 文档索引

- **上手** — [安装与快速开始](docs/getting-started.md) · [VS Code](docs/vscode.md)
- **使用** — [交互与命令](docs/interaction.md) · [使用说明](docs/user-guide.md)（[English](docs/user-guide.en.md)） · [主题系统](docs/themes.md)
- **配置** — [配置参考](docs/configuration.md)
- **实现** — [架构与限制](docs/architecture.md) · [会话挂载运行时](docs/session-mount-runtime.md)
- **插件** — [准入与开发指南](tui-profile/docs/plugin-admission-and-development.md) · [插件速览](docs/plugins.md)
- **参与** — [贡献与开发约定](docs/contributing.md) · [路线图](docs/roadmap.md) · [社区管理框架](docs/community-management.md)

中英对照全量索引：[docs/README.md](docs/README.md)。

## 社区

- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem) 是社区插件、模板与收录列表的家。欢迎来发插件、提创意、互相取暖 🐋
- **社区交流群**：使用问题、插件创意、功能许愿，都欢迎进来聊。
- **行为准则**：参与前请读一遍[贡献者行为准则](CODE_OF_CONDUCT.md)。

| 微信群（dsh-TUI 社区交流 4 群） | QQ 群（群号 572549239） |
| :---: | :---: |
| <img src="screenshots/wechat-group.jpg" alt="dsh-TUI 社区交流 4 群微信群二维码" width="200"> | <img src="screenshots/qq-group.png" alt="dsh-TUI 社区交流群 QQ 群二维码" width="200"> |

> 微信群二维码约 7 天过期一次，如遇失效请走 QQ 群（572549239），或开个 issue 提醒我们更新。

## 权限与安全边界

> **Windows 安全警告：** Windows profile 默认 `danger-full-access`、approval 默认 `never`，工具访问不受限制。在敏感凭证或不可信仓库旁启动前，先检查并收紧 profile。

不自带沙箱：用当前 DSH profile 的文件、Shell、sandbox 与 approval 策略。权限预设来自 DSH `permissionPresets` registry。

详见[权限边界](docs/architecture.md#权限与安全边界)。

## 致谢

- 像素鲸鱼娘的 22 帧手绘原图与闲置动画，移植自 **[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)**。原图在 Excel 里逐格绘制。闲置动画有摆鱼鳍、拍尾巴、入睡冒 Z、点击冒爱心。dsh-ui-whale 是 DeepSeek Harness Web 端鲸鱼宠物插件，作者 [@lhh010](https://github.com/lhh010)，BSD-3-Clause。感谢作者与灵感 🐋💜

## 友情链接

朋友们开发的[社区、相关项目与周边工具](docs/links.md)

## Stars

<!-- star-history:start -->
[![Star History](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#ccch1mneyyy/dsh-TUI&Date)
<!-- star-history:end -->

## License

[MIT](LICENSE)
