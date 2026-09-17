
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

>一个面向 DeepSeek Harness 的交互式终端界面插件：提供像素鲸鱼顶栏、实时工作状态行、流式思考展示、双击 Esc 时间回溯、上下文进度条与 TPS 仪表。
>零核心改动，纯插件挂载。安装插件即可启用，卸载后不会留下核心补丁。
>
>An interactive terminal UI plugin for DeepSeek Harness: pixel-whale header, live work status, streaming thinking display, double-Esc time rewind, a context progress bar, and a TPS gauge.
>Zero core changes, pure plugin mounting. Install to enable; uninstall leaves no core patches.

## 🎉 官方收录

本插件被 **DeepSeek Harness 官方公众号** 推文收录，也被 [dshfind](https://dshfind.com/ccch1mneyyy/dsh-TUI) 插件目录与 [GitHub Trending](https://trendshift.io/repositories/146168) 收录，同时登上了Github Treding日榜第七

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
        <strong>dshfind Github Treding榜第七 </strong>
      </td>
    </tr>
  </table>
</div>

## 界面预览

<picture>
  <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-zh-mobile.svg">
  <img src="docs/assets/readme/preview-zh.svg" alt="dsh-TUI 实际运行态预览：Logo 头部、消息流、思考预览、工具卡、输入框与状态栏。" width="1200">
</picture>

这个 CSS 动画 SVG 按真实 TUI 组件层级重构，会在 GitHub README 原页面自动播放：顶部是 `LogoV2`，中间是消息、思考与工具卡，底部固定输入框和状态栏。GitHub 会清洗 README 中的真实表单控件，因此输入过程属于运行态演示，而不是可编辑终端。

## 文档索引

<!-- readme-svg-navigation:start -->
<p align="center">
  <a href="docs/getting-started.md"><img src="docs/assets/readme/nav-start-zh.svg" width="390" alt="安装与快速开始"></a>
  <a href="docs/interaction.md"><img src="docs/assets/readme/nav-interaction-zh.svg" width="390" alt="交互与命令"></a>
  <a href="docs/configuration.md"><img src="docs/assets/readme/nav-configuration-zh.svg" width="390" alt="配置参考"></a>
  <a href="docs/themes.md"><img src="docs/assets/readme/nav-themes-zh.svg" width="390" alt="主题系统"></a>
  <a href="docs/architecture.md"><img src="docs/assets/readme/nav-architecture-zh.svg" width="390" alt="架构与限制"></a>
  <a href="docs/vscode.md"><img src="docs/assets/readme/nav-vscode-zh.svg" width="390" alt="VS Code 使用指南"></a>
  <a href="https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md"><img src="docs/assets/readme/nav-plugins-zh.svg" width="390" alt="插件准入与开发"></a>
  <a href="docs/contributing.md"><img src="docs/assets/readme/nav-contributing-zh.svg" width="390" alt="贡献与开发约定"></a>
  <a href="docs/community-management.md"><img src="docs/assets/readme/nav-community-zh.svg" width="390" alt="社区管理框架"></a>
  <a href="docs/roadmap.md"><img src="docs/assets/readme/nav-roadmap-zh.svg" width="390" alt="项目路线图"></a>
  <a href="docs/README.md"><img src="docs/assets/readme/nav-index-zh.svg" width="390" alt="完整文档索引"></a>
  <a href="docs/links.md"><img src="docs/assets/readme/nav-links-zh.svg" width="390" alt="社区与相关项目"></a>
</p>
<!-- readme-svg-navigation:end -->

完整的中英文索引见 [`docs/README.md`](docs/README.md)。

## 核心能力

| 能力域 | 核心能力 | 关键入口与行为 |
| --- | --- | --- |
| 对话与工具 | 流式 Markdown、结构化工具卡、命令与文件补全、`@` 文件引用、多主题与实时状态 | 工具卡支持折叠/展开；状态栏显示工作状态、TPS、缓存、推理等级、token、Git 与会话信息 |
| 会话工作流 | 会话恢复、总览、后台化、分支、压缩、导出、模型热切换 | `/resume`、`/agentview`、`/new`、`/workspace`、`/compact`、`/export`、`/btw` |
| 编辑与导航 | Vim 输入、鼠标选区、全屏草稿编辑、双击 Esc 回溯、全历史时间轴 | `/vim`、`Ctrl+Shift+E`、`Ctrl+Enter`、`Ctrl+O`；折叠窗口外的历史轮次仍可直接跳转 |
| 图片与附件 | PNG/JPEG/WebP/GIF 持久附件，Kitty/Sixel 内嵌缩略图，统一大图预览 | 支持适应窗口、100% 与 200%/400%/800% 缩放、平移、前后切图和打开原图；协议或解码失败时保留同尺寸文字回退 |
| DSH 原生能力 | Agent preset、技能、MCP、目标、待办、subagent 与 `ask_user_question` | 全部通过 DSH 现有服务和 registry 接入；dsh-TUI 不复制 Agent、模型、工具或持久化域逻辑 |
| 长会话性能 | 事件投影、差分输出、消息虚拟化、分帧绘制、全局 LRU 与有界缓存 | 图片读取/解码最多两路并发；不可见图像停止编码，队列与帧传输均有容量限制 |
| 扩展与集成 | 浏览器交互、computer use、插件接缝、VS Code companion | 通过生态插件扩展；VS Code 支持多会话、历史与指定会话恢复 |
| 动态界面 | 三组鲸鱼开场、欢迎期点击/闲置动画、`moon8` 工作状态动画 | 首个 Agent 任务开始后鲸鱼定格为标准帧，避免持续渲染开销 |

终端图片协议默认自动探测 Kitty，其次使用 DA1 声明的 Sixel；可将
`DSH_TUI_IMAGE_PROTOCOL` 设置为 `auto`、`kitty`、`sixel` 或 `none`。完整行为、资源边界与
权限模型见[架构与限制](docs/architecture.md)，快捷键和命令见[交互与命令](docs/interaction.md)。


## 快速开始

前置条件：安装[Nodejs](https://nodejs.org/zh-cn)与[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，注册`DEEPSEEK_API_KEY`。

安装命令：

```sh
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
```

启动命令：

```bash
# 完整命令
dsh-tui
# 如果你不想按键盘七次
dst
```

如果你想手动安装，可以使用仓库根目录的 `install.sh`：

```sh
sh install.sh
# 或：dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
# 之后 dsh-tui 与 dsh --profile dsh-tui 等价
```

> **新用户提示**：若 `dsh plugin` 安装时报 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥11 默认阻止带安装脚本的依赖，如 `@google/genai`、`protobufjs`——这些脚本运行时不需要，忽略即可），在 profile 的 `pnpm-workspace.yaml` 里加入：
>
> ```yaml
> allowBuilds:
>   '@google/genai': false
>   protobufjs: false
> ```
>
> `/update` 与 `dsh-tui update` 会自动写入这份配置，无需手工处理。

更面向零基础的安装流程、profile 叠加机制、源码构建与常见问题见[安装与快速开始](docs/getting-started.md)。

### 更新与启动前诊断

启动后会在后台检查新版本，不会自动安装。空闲时执行 `/update`，更新成功后会
重启并恢复当前会话；终端中的 `dsh-tui update` 使用同一更新流程，但不启动 TUI。

| 命令 | 用途 |
| --- | --- |
| `dsh-tui update` | 更新当前 `dsh-tui` profile，并尝试对齐全局启动器 |
| `dsh-tui doctor` | 检查 dsh、pnpm、profile、版本与凭证是否配置；不输出密钥值 |
| `dsh-tui version` | 显示启动器与 profile 版本，等同于 `--version` / `-v` |
| `dsh-tui help` | 显示命令帮助，等同于 `--help` / `-h` |

`dst` 支持相同子命令。`help`、`version` 无需初始化 profile；`doctor` 可在
TUI 启动失败时运行。子命令属于 npm 安装的启动器，仓库根目录的 `dsh-tui.cmd`
只负责启动，不提供这些子命令。

全局启动器的自动对齐取决于启动方式和目录写权限，并非保证成功；出现版本不一致
提示时，按提示中的精确版本命令修复。日常更新与旧启动器修复步骤统一见
[更新到最新版本](docs/getting-started.md#更新到最新版本)。



## 插件扩展与开发指南

想为 dsh-TUI 做插件/扩展？欢迎加入生态！

- **接口与兼容性协定 / 插件开发指南**：[终端交互生态插件准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)（准入规范、接缝、契约、验证清单）
- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)（社区插件与模板的家）
- **模板仓库**：[plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)（从模板起步，5 分钟出一个插件）
- **参考实现**：`dsh-working-activity`（实时工作状态行：TUI 槽位 + `activity/status` 会话事件双出口）

### 接缝稳定性参考

按当前实现成熟度给出的**非正式**分级，帮助插件作者评估投入；正式状态与兼容性协定以
[准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)为准：

| 分级 | 接缝 |
| --- | --- |
| 稳定候选（形态冻结；如有破坏性变更，先在次版本弃用告警再移除） | 六 设置区块 · 八 全屏场景 · 十 托管对话框 · 十一 状态行 · 十二 键盘快捷键 · 十三 条目渲染器 |
| 实验性（仍可能随 dsh-std / 准入规范演进调整） | 九 决策事件 · toast 通知（`ctx.tuiToast`，新增） |
| 跟随上游（稳定性由 cordis / dsh 官方机制决定） | 一 会话事件 · 二 官方 prompt 槽位 · 三 技能打包 · 四 主题 · 五 system prompt 段 · 七 profile 组合 |

另：`@deepseek-harness-tui/dsh-tui/api`（纯类型入口）为实验性公开面；
`@deepseek-harness-tui/dsh-tui/test-utils` 子路径与 `ctx.tuiPluginHost.grants.corrupt`
已随 adapter 分层重构（#705）移除，`grants` 收窄为 `HostGrantFacade`，迁移细节见该 PR。



## 社区

- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem) —— 社区插件、模板与收录列表的家。欢迎来发插件、提创意、互相取暖 🐋
- **社区交流群**：使用问题、插件创意、功能许愿，都欢迎进来聊。
- **行为准则**：参与前请读一遍[贡献者行为准则](CODE_OF_CONDUCT.md)。

| 微信群（DSH-Plugins 社区交流 3 群） | QQ 群（群号 572549239） |
| :---: | :---: |
| <img src="screenshots/wechat-group.jpg" alt="DSH-Plugins 社区交流 3 群微信群二维码" width="200"> | <a href="screenshots/qq-group.jpg"><img src="screenshots/qq-group.jpg" alt="dsh-TUI 社区交流群 QQ 群二维码，群号 572549239，点击查看原图" width="280"></a> |

> 微信群二维码约 7 天过期一次，如遇失效请走 QQ 群（572549239），或开个 issue 提醒我们更新。

## 权限与安全边界

> **Windows 安全警告：** Windows profile 默认使用 `danger-full-access`，且 approval 默认是 `never`。这会授予工具不受限制的访问权限；在敏感凭证或不可信仓库环境中启动前，务必先检查并收紧 profile 配置。

`dsh-TUI` 不实现独立沙箱，而是使用当前 DSH profile 的文件、Shell、sandbox 与 approval 策略。权限预设来自 DSH `permissionPresets` registry：服务缺失时使用 legacy 三项兼容名册；服务已挂载但为空、损坏或不一致时标记为 unavailable，TUI fail closed，不伪造名册。可用 registry 按声明顺序提供第三方预设并自动进入补全、picker 与 `Shift+Tab` 循环（排除 `custom`/`status`、canonical 预设、重复 identity 与不安全 token）；首次观察遵循 registry 顺序，后续刷新保留已见 identity 的相对顺序。服务可用时 `/permission` 以本地命令形式常驻菜单：切换优先调用官方 `/permission <preset>` 命令；命令行未暴露给本 agent 时，回退到 permissionPresets 服务自身的官方写路径（与命令 handler 同一实现，写真实 `permission/preset`/`sandbox/mode`/`approval/policy` 事件，绝不由 TUI 伪造），并以事件/读回确认；两条路都不可用时显式提示，绝不静默。计划模式退出先恢复进入前的 atom，再把权限身份还原到你进入前所在的预设（registry 仍提供时）。在包含敏感凭证或不可信仓库的环境中启动前，请先检查 profile 配置。

详见[权限边界与已知限制](docs/architecture.md#权限与安全边界)。

### 致谢

- 像素鲸鱼娘的 22 帧手绘原图（Excel 逐格绘制）与闲置动画行为（摆鱼鳍、拍尾巴、入睡冒 Z、点击冒爱心）移植自 **[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)**（DeepSeek Harness Web 端鲸鱼宠物插件，作者 [@lhh010](https://github.com/lhh010)，BSD-3-Clause），感谢作者与灵感 🐋💜

### 友情链接

朋友们开发的[社区、相关项目与周边工具](docs/links.md)

## Stars

<!-- star-history:start -->
[![Star History](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#ccch1mneyyy/dsh-TUI&Date)
<!-- star-history:end -->


## License

[MIT](LICENSE)
