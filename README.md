
<p align="center">
  <img src="docs/assets/logo.svg" alt="dsh-TUI - DeepSeek Harness terminal interface" width="560">
</p>
<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
</p>


<p align="center">
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm" src="https://img.shields.io/npm/v/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <img alt="官方收录" src="https://img.shields.io/badge/DeepSeek%20Harness%20官方公众号-收录-brightgreen">
</p>

# dsh-TUI

> 一个美观且实用的 Claude Code 风格 TUI 插件：像素鲸鱼顶栏、双流光大字、实时工作状态行、思考流式展开、双击 Esc 时间回溯、蓝白上下文进度条 + TPS 仪表。
> 零核心改动，纯插件挂载。安装插件即可启用，卸载后不会留下核心补丁。

## 🎉 官方收录

本插件被 **DeepSeek Harness 官方公众号** 推文收录，作为"内测用户精选插件"展示：

<p align="center">
  <img src="screenshots/wechat-official.png" alt="DeepSeek Harness 官方公众号推文收录 dsh-TUI" width="560">
</p>

## 核心能力

  - **终端原生交互**：流式 Markdown、结构化工具卡、命令与文件补全、`@` 文件引用
    （消息任意位置补全，发送时自动附加文件内容/目录列表）、历史搜索、消息选择、
    inline/alternate-screen 两种渲染模式，以及 `/lang` 中英界面语言切换。
  - **可观察的 Agent 状态**：实时工作状态、上下文分段进度、TPS、缓存命中率、
    推理等级、输入/输出 token 与 Git/会话信息。
  - **完整会话工作流**：`/resume`、`/new`、`/compact`、`/export`、`/btw` 侧问、
    模型切换，以及双击 `Esc` 发起的会话 rewind/fork。
  - **DSH 官方能力接入**：Agent preset、Skills、MCP、Goals、Todos、子代理、
    `ask_user_question` 问卷都通过现有服务或注册表连接。
  - **为长会话设计**：事件驱动投影、差分终端输出、消息虚拟化、回放合并与有界缓存，
    避免渲染成本和内存随会话无限增长。

## 界面预览

![首屏：像素鲸鱼顶栏](screenshots/splash.png)

![工作状态行 + 上下文进度条](screenshots/working-line.png)

## 快速开始

前置条件：可用的终端 TTY、官方 `dsh` CLI，以及 `pnpm` 10+。运行模型还需要
`DEEPSEEK_API_KEY`。

```sh
# 1. 全局安装 CLI + 本插件（本插件自带 dsh-tui 直达命令）
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# 2. 启动（首次运行会自动初始化 dsh-tui profile，需 pnpm）
dsh-tui
```

备选——手工安装 profile（仓库根目录 `install.sh` 已封装，含 pnpm 预检）：

```sh
sh install.sh
# 或：dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
# 之后 dsh-tui 与 dsh --profile dsh-tui 等价
```

`dsh-tui --resume` 恢复上次会话；Windows 也可用仓库里的 `dsh-tui.cmd`（等价）。

TUI 启动后会在后台检查 npm 是否有新版本；发现更新时会提示，输入 `/update`
即可自动更新并重启恢复当前会话。

旧版 `dsh-cc-tui` / `cc-tui` profile 的迁移命令与兼容数据说明见
[安装与快速开始](docs/getting-started.md#从旧包迁移)。

安装流程、profile 叠加机制、源码构建与常见问题见
[安装与快速开始](docs/getting-started.md)。

## 快捷键

| 键 | 功能 |
|---|---|
| `Enter` | 发送（`Shift+Enter` 换行）；命令菜单打开时执行选中项 |
| `Ctrl+C` | 中断当前回合；空闲时连按两次退出 |
| `Esc` | 关闭命令/文件菜单；空闲双击清空输入；**空输入双击 = 时间回溯** |
| `Ctrl+O` | 展开/收起详情（思考全文、工具参数与输出） |
| `Ctrl+R` | 历史消息搜索 |
| `/` | 会话内全文搜索（`n`/`N` 跳转） |
| `Tab` / `Enter` | 命令 / `@` 文件补全（目录可继续深入） |
| `Ctrl+V` | 粘贴：文本直接插入光标处；**Explorer 复制的文件/图片 → 插入文件路径** |
| `?` | 快捷键菜单 |
| `Shift+↑` | 消息选择模式（Enter 展开单条） |

**macOS 修饰键**：上表中 Windows/Linux 的 `Ctrl+<键>` 在 macOS 上同时可用 `⌘<键>`
（如 `⌘V` 粘贴、`⌘O` 展开详情、`⌘Enter` 立即发送）；仅 `Ctrl+C` / `Ctrl+D`
（中断/退出）保持 Ctrl 不变，避免与 macOS 系统级 `⌘C` 复制等肌肉记忆冲突。
`⌘` 需终端支持扩展键盘协议（iTerm2 / kitty / WezTerm / ghostty / tmux）；
macOS 自带 Terminal.app 会自行消费 `⌘` 快捷键，请继续使用 `Ctrl`。

**鼠标（`fullscreen: true` 全屏模式；默认关，profile 补丁层覆盖开启）**

| 操作 | 功能 |
|---|---|
| 拖拽选择 | 应用内文本选区，**松开即复制**（OSC 52 + `wl-copy`/`xclip`/`xsel` 原生兜底；tmux 内走 `load-buffer -w`），复制后自动取消选区并弹出「已复制 N 个字符」提示 |
| 双击 / 三击 | 选词 / 选行，同样即选即复制 |
| 滚轮 | 滚动消息列表 |
| `Esc` | 拖拽进行中取消选区（不复制） |

**问卷（模型发起 `ask_user_question` 时）**

| 键 | 功能 |
|---|---|
| `↑/↓` | 选择选项 |
| `Space` | 多选题勾选/取消 |
| `Tab` | 切到自定义回答（不选选项直接打字） |
| `Enter` | 提交当前选择 |
| `Esc` | 中断提问（模型收到 ASK_ABORTED，可继续对话） |

**本地命令（CC 指令全集复刻，均走 DSH 官方链路）**

| 分组 | 命令 |
|---|---|
| 会话 | `/new` 新会话 · `/resume` 恢复 · `/rename` 重命名 · `/clear` 清屏 · `/compact` 压缩 · `/export` 导出 Markdown · `/trace` 轨迹时间线 |
| 状态 | `/status` 会话信息 · `/cost` token 用量 · `/doctor` 环境自检 · `/config` 配置来源 · `/init` 创建 AGENTS.md |
| 模型 | `/model` 选择器 · `/thinking` 思考显示 · `/tokens` token 明细 · `/theme` 主题选择器 · `/lang` 中英界面切换 |
| 账号/策略 | `/login` 凭证状态 · `/logout` 登出说明 · `/permissions` 权限说明 · `/add-dir` 文件策略范围 · `/hooks` · `/mcp` · `/memory` |
| 技能 | `/audit` 代码审计 · `/bug` bug 报告 · `/review` 代码评审 · `/practice` 编程练习 · `/pr_comments` PR 评论 · `/release-notes` 发布说明 · `/vuln-check` 漏洞检查 |
| 其它 | `/agents` 子代理列表 · `/update` 自动更新并重启 · `/vim` · `/terminal-setup` · `/connect` · `/help` · `/exit` |
| 注册表 | `/plan` `/goal`（DSH 命令注册表插件，随插件自动并入 `/` 菜单） |

## 文档

| 主题 | 内容 |
| --- | --- |
| [安装与快速开始](docs/getting-started.md) | 前置条件、安装、启动、profile 生命周期、源码开发 |
| [配置参考](docs/configuration.md) | Cordis 覆盖、配置字段、Agent preset、MCP、环境变量 |
| [主题系统](docs/themes.md) | 内置主题、自动检测、自定义 JSON 主题与校验规则 |
| [交互与命令](docs/interaction.md) | 快捷键、鼠标、问卷、slash command 与会话工作流 |
| [架构与限制](docs/architecture.md) | 运行链路、渲染与持久化设计、安全边界、已知限制 |
| [贡献与开发约定](docs/contributing.md) | 贡献流程、仓库地图、构建产物、验证矩阵与修改规则 |

完整的中英文索引见 [`docs/README.md`](docs/README.md)。

## 配置与扩展

- **Agent preset**：四种官方 Agent 模式（`standard` / `code` / `minimal` / `cordis`），
  `/preset` 切换；已产生对话的会话不可切换，空白会话立即生效。默认 preset 持久化
  在 `~/.dsh-tui/agent-preset.json`；`/model` 的选择持久化在 `~/.dsh-tui/model.json`。
  详见[配置参考](docs/configuration.md#agent-preset)。
- **自定义主题**：`/theme` 选择器（内置 `light` / `dark` / `dark-ansi`），也支持
  `~/.dsh-tui/themes/<名字>.json` 自定义主题，选中即热切换并持久化；
  `DSH_TUI_THEME` 环境变量 > 持久化选择 > OSC 11 终端背景自动检测。
  详见[主题系统](docs/themes.md)。
- **MCP**：通过 `@deepseek-ai/dsh-mcp-client` 挂载服务器，工具以
  `mcp__<服务器>__<工具>` 注册；`/mcp` 查看连接状态。
  详见[配置参考](docs/configuration.md#mcp)。

## 工作方式

```text
dsh profile
  -> dsh-base
  -> dsh-TUI Cordis patch
  -> Agent preset + DSH services
  -> session/event
  -> Channel projection
  -> React components
  -> ported Ink/Yoga renderer
  -> terminal
```

TUI 只负责交互与呈现。会话日志是对话真源，模型调用、工具执行、fork/resume、
compaction 和持久化继续由 DSH 服务拥有。更详细的模块边界与性能设计见
[架构文档](docs/architecture.md)。

## 技术要点

- **Gentle Mist Blue 配色**：雾蓝只承担品牌、焦点、交互与高亮，正文保持中性灰；
  启动时查询终端背景色（OSC 11）自动选浅色/深色调色板，终端不响应时回退深色。
- **事件驱动渲染**：`session/event` 事件流 → 增量差分渲染，滚动状态独立维护。
- **布局级虚拟化**：长会话的每帧成本从 O(全会话) 降到 O(可视窗口)——屏幕外的
  消息行渲染为"量高占位符"，其子树完全不参与布局。
- **上下文进度条**：参考 pi-nano-context 算法（最大余数法分段着色 + 多级缩略读数）。
- **TPS 仪表**：参考 pi-tps-meter——流式 1/8 格 gauge、历史 min-max sparkline、
  速度语义色（≥50 绿 / ≥20 黄 / <20 红）。
- **working-activity 生态**：工作状态行消费
  [dsh-working-activity](https://github.com/ccch1mneyyy/dsh-working-activity)
  的 log-only `activity/status` 事件（与 Web UI 同一数据源）。
- **终端粘贴**：raw 模式下 Ctrl+V 由应用接管——PowerShell `Get-Clipboard` 读取，
  Explorer 复制的文件/图片插入文件路径，纯文本原样插入光标处。

## 已知限制

- 注入上下文（plugin source 内容）未做独立展示，随系统提示词并入进度条统计。
- `/model` 实时切换走"会话 fork 续聊"（DSH 无原位换模型 API）：历史原样保留，
  新会话路由到新模型，旧会话仍留在 `/resume` 列表里；选择写入
  `~/.dsh-tui/model.json`，重启与 `/new` 均沿用。
- `Ctrl+V` 读剪贴板依赖 PowerShell `Get-Clipboard`：剪贴板被其他进程短暂锁定
  时自动重试，持续锁定时静默放弃。
- 退出时以进程退出收尾，不等待 agent 异步落盘（持久化由 persistence 插件兜底）。
- 工具级审批已实现：approval 服务 + TUI answerer（CC 式审批面板）消费审批流，
  权限提升命令会弹出审批条。`/permission` 预设切换由 dsh-base 的
  `permission-presets` 插件提供，profile 组合默认可用；裸组合 `cordis.yml`
  未挂载该插件（无 `/permission` 命令）。
- `/vim` `/connect` `/hooks` `/memory` 为 CC 同名占位：对应能力在 DSH 侧无等价
  机制，命令会给出明确说明而非静默。

完整已知限制与安全边界见[架构与限制](docs/architecture.md)。

## 开发

CI 使用 Node 24 与 pnpm 11；包声明支持 Node `^22.19 || >=24`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`pnpm build` 会把 `src/` 编译到已提交的 `lib/types/`。修改源码时必须同步生成产物；
渲染、问卷和工具卡还需运行对应回归脚本。

## 权限与安全边界

`dsh-TUI` 不实现独立沙箱，而是使用当前 DSH profile 的文件、Shell、sandbox 与
approval 策略。仓库提供的 profile 在非 Windows 平台默认采用工作区约束与审批；
Windows 当前没有对应的沙箱后端，组合会退回到 `danger-full-access` 且不弹审批。
在包含敏感凭证或不可信仓库的环境中启动前，请先检查 profile 配置。

详见[权限边界与已知限制](docs/architecture.md#权限与安全边界)。

### 友情链接

朋友们开发的[社区、相关项目与周边工具](docs/links.md)

## 趋势

<!-- star-history:start -->
[![Star History](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#ccch1mneyyy/dsh-TUI&Date)
<!-- star-history:end -->


## License

[MIT](LICENSE)
