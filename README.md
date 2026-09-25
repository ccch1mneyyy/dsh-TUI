
<p align="center">
  <img src="docs/assets/readme/logo.svg" alt="dsh-TUI 动态 Logo：鲸鱼、我想要、点亮星标、感谢、已加星标" width="560">
</p>
<p align="center">
  <strong>简体中文</strong> | <a href="https://github.com/ccch1mneyyy/dsh-TUI/blob/main/README.md">English (upstream)</a>
</p>


<p align="center">
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm" src="https://img.shields.io/npm/v/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/says693/dsh-TUI-693/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/says693/dsh-TUI-693/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/says693/dsh-TUI-693/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/says693/dsh-TUI-693?style=flat-square&color=4b6fff"></a>
  <img alt="官方收录" src="https://img.shields.io/badge/DeepSeek%20Harness%20官方公众号-收录-brightgreen">
</p>

# dsh-TUI

>一个面向 DeepSeek Harness 的交互式终端界面插件： 零核心改动，纯插件挂载。安装插件即可启用，卸载后不会留下核心补丁。
>提供像素鲸鱼顶栏、实时工作状态行、流式思考展示、双击 Esc 时间回溯、上下文进度条与 TPS 仪表。
>
>An interactive terminal UI plugin for DeepSeek Harness: pixel-whale header, live work status, streaming thinking display, double-Esc time rewind, a context progress bar, and a TPS gauge.
>Zero core changes, pure plugin mounting. Install to enable; uninstall leaves no core patches.


## 🎉 官方收录与上游信息

本项目基于 [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 演进。当前官方公众号、[dshfind](https://dshfind.com/ccch1mneyyy/dsh-TUI) 与 [Trendshift](https://trendshift.io/repositories/146168) 条目仍指向上游项目页面，并在 GitHub Trending **TypeScript 日榜中位列第七**。

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
        <strong>TypeScript 日榜第七</strong>
      </td>
    </tr>
  </table>
</div>

## 界面预览

<picture>
  <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-zh-mobile.svg">
  <img src="docs/assets/readme/preview-zh.svg" alt="dsh-TUI 隔离安装实机采集：欢迎页、命令补全、帮助与输入；22 帧像素动画。" width="1200">
</picture>

## 文档索引

<!-- readme-svg-navigation:start -->
<p align="center">
  <a href="docs/getting-started.md"><img src="docs/assets/readme/nav-start-zh.svg" width="390" alt="安装与快速开始"></a>
  <a href="docs/configuration.md"><img src="docs/assets/readme/nav-configuration-zh.svg" width="390" alt="配置参考"></a>
  <a href="docs/interaction.md"><img src="docs/assets/readme/nav-interaction-zh.svg" width="390" alt="交互与命令"></a>
  <a href="docs/themes.md"><img src="docs/assets/readme/nav-themes-zh.svg" width="390" alt="主题系统"></a>
  <a href="docs/architecture.md"><img src="docs/assets/readme/nav-architecture-zh.svg" width="390" alt="架构与限制"></a>
  <a href="docs/vscode.md"><img src="docs/assets/readme/nav-vscode-zh.svg" width="390" alt="VS Code 使用指南"></a>
  <a href="https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md"><img src="docs/assets/readme/nav-plugins-zh.svg" width="390" alt="插件准入与开发"></a>
  <a href="docs/contributing.md"><img src="docs/assets/readme/nav-contributing-zh.svg" width="390" alt="贡献与开发约定"></a>
</p>
<!-- readme-svg-navigation:end -->

## 核心能力

上游还支持 Mermaid 代码块的 Unicode 图表、可点击时间轴、Kitty/Sixel 图片预览、VS Code 选区通道、缓存命中率与推理强度显示，以及面向长会话的虚拟化渲染。完整功能列表见[上游中文说明](README_ZH.md)。

<table>
  <thead><tr><th width="112" align="left">能力</th><th align="left">亮点</th></tr></thead>
  <tbody>
    <tr><td><strong>对话工具</strong></td><td>流式回复、可折叠工具卡、文件引用与实时状态。</td></tr>
    <tr><td><strong>会话管理</strong></td><td>恢复、分支、后台任务、压缩与导出；随时切换模型。</td></tr>
    <tr><td><strong>编辑导航</strong></td><td>Vim 输入、全屏草稿、鼠标选区与历史回溯。</td></tr>
    <tr><td><strong>视觉体验</strong></td><td>图片预览与缩放、多主题、欢迎动画。</td></tr>
    <tr><td><strong>生态扩展</strong></td><td>接入 DSH 技能、MCP、子代理及 VS Code。</td></tr>
  </tbody>
</table>

## 快速开始

前置条件：[Node.js](https://nodejs.org/zh-cn)（`^22.19 || >=24`）、交互式终端 TTY、官方 [DeepSeek Harness CLI](https://github.com/deepseek-ai/deepseek-harness) 与 `pnpm` 10+。模型请求还需配置 `DEEPSEEK_API_KEY`。

主要兼容目标是 DSH `0.1.7-rc.1`，覆盖 Shell API、V4 session messages、声明式 preset 与 profile 设置；旧版主机保留兼容路径。DSH 0.1.7 的 `/settings` 使用 TUI 实际 Loader entry ID（包括自定义 ID），profile 依赖需要 `@deepseek-ai/schemastery` `3.18.3+`；schema 不兼容时会直接给出修复提示。详见[配置参考](docs/configuration.md)。

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
> 更新时还会跳过其他平台的 `@img/sharp-*` 原生包，减少无用下载；`/update` 与 `dsh-tui update` 会自动写入相关配置，无需手工处理。

更面向零基础的安装流程、profile 叠加机制、源码构建与常见问题见[安装与快速开始](docs/getting-started.md)。

### 更新与启动前诊断

启动后会在后台检查新版本，不会自动安装。空闲时执行 `/update`，更新成功后会
重启并恢复当前会话；终端中的 `dsh-tui update` 使用同一更新流程，但不启动 TUI。

| 命令 | 用途 |
| --- | --- |
| `dsh-tui update` | 更新当前 `dsh-tui` profile，并尝试对齐全局启动器 |
| `dsh-tui doctor` | 检查 dsh、pnpm、profile、版本与凭证是否配置；不输出密钥值 |
| `dsh-tui safe` | 只读诊断、插件清单与修复建议；`safe --rescue` 可创建干净的救援 profile |
| `dsh-tui version` | 显示启动器与 profile 版本，等同于 `--version` / `-v` |
| `dsh-tui help` | 显示命令帮助，等同于 `--help` / `-h` |

`dst` 支持相同子命令。`help`、`version` 无需初始化 profile；`doctor` 可在
TUI 启动失败时运行。子命令属于 npm 安装的启动器，仓库根目录的 `dsh-tui.cmd`
只负责启动，不提供这些子命令。

全局启动器的自动对齐取决于启动方式和目录写权限，并非保证成功；出现版本不一致
提示时，按提示中的精确版本命令修复。日常更新与旧启动器修复步骤统一见
[更新到最新版本](docs/getting-started.md#更新到最新版本)。



<details>
<summary>补充使用说明与详细参考</summary>

- 使用 `dsh-tui --resume`（或 `dst --resume`）恢复最近选中的会话；Windows 仓库启动脚本同样支持。
- [安装与快速开始](docs/getting-started.md)：安装、profile 组合、更新与旧包迁移。
- [交互与命令](docs/interaction.md)：快捷键、鼠标操作、问卷与会话工作流。
- [配置参考](docs/configuration.md)、[架构与限制](docs/architecture.md)、[贡献与开发约定](docs/contributing.md)：配置、已知限制及开发验证。
- [VS Code 使用指南](docs/vscode.md)：集成终端与配套扩展。
- **Herdr**：可直接在 Herdr 面板中运行 `dsh-tui`；会报告空闲、工作中与等待输入状态，Herdr 外不启用该集成。通过 `herdr agent start --kind dsh-tui` 启动及服务重启后的自动恢复，仍依赖上游提供原生 agent kind。相关说明见[上游英文版](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/README.md#quick-start)。

</details>

## 快捷键与鼠标

`Enter` 发送 · `Tab` 补全 · `Ctrl+Enter` 中断并发送 · `Alt+Up` 取回上一条消息 · `Esc` 关闭，双击 `Esc` 回溯 · `Ctrl+O` 查看详情 · `Ctrl+R` 搜索历史 · `Ctrl+V` 粘贴 · `Ctrl+Shift+E` 全屏草稿编辑器 · `?` 查看快捷键 · `←` 将会话转入后台。

模型工作期间：`Enter` 用于 steer，`Tab` 排队 follow-up，`Ctrl+Enter` 中断并发送。全屏模式下支持拖拽选择复制、双击/三击选择词或行，以及点击工具卡、时间线刻度和图片预览。

完整说明见[交互与命令](docs/interaction.md)。

## 内置命令

会话管理：`/resume` · `/home` · `/agentview` · `/bg`；会话工作流：`/model` · `/new` · `/compact` · `/export` · `/btw` · `/tree` · `/fork` · `/rewind`；诊断与扩展：`/settings` · `/status` · `/cost` · `/jobs` · `/skills` · `/mcp` · `/login` · `/update`。

`/bg` 或空输入时按 `←` 可将会话转入后台，按 `Esc` 返回。后台会话运行在当前进程中，TUI 退出后会停止，但日志会保留。

## 配置与扩展

Agent preset、主题、MCP 服务和环境变量见[配置参考](docs/configuration.md)与[主题系统](docs/themes.md)。插件接口、准入规则和模板见[插件准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)。

## 工作原理

```text
dsh profile → dsh-base → dsh-TUI Cordis patch → agent preset + DSH services
  → session/event → Channel projection → React components → Ink/Yoga renderer → terminal
```

TUI 负责交互和呈现，会话日志是事实来源；模型、工具和持久化由 DSH 服务负责。长会话按可见窗口渲染，避免随历史长度线性扩大渲染开销。运行时路径、模块边界、性能和持久化位置见[架构与限制](docs/architecture.md)。

## 已知限制

- 注入式插件上下文没有独立显示，会计入上下文分段。
- `/model` 通过分支切换会话，旧会话仍可在 `/resume` 中找到。
- `Ctrl+V` 依赖平台剪贴板工具，不支持的位图格式会被拒绝。
- 后台会话属于当前进程，TUI 退出后停止。
- `/thinking` 不持久化；`minimal` preset 下不可用 `/compact`；`/update` 需要通过 `dsh --profile` 启动，并且运行 turn 时会拒绝更新。

完整限制见[架构与限制](docs/architecture.md)。

## 开发与验证

CI 使用 Node 24 与 pnpm 11；包支持 Node `^22.19 || >=24`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`lib/types/` 为构建生成目录。`pnpm build` 会清理并重新生成类型后执行构建门禁；不支持 Git URL 安装，应安装 registry 包：

```sh
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
```

渲染、问卷或工具卡变更还需要运行对应的回归脚本。
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



核心仓库保持独立，社区插件由各自作者拥有并维护。生态组织维护收录与准入规则，不为社区插件的功能、质量或安全作担保；作者负责其维护与安全。

## 社区

- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem) —— 社区插件、模板与收录列表的家。欢迎来发插件、提创意、互相取暖 🐋
- **社区交流群**：使用问题、插件创意、功能许愿，都欢迎进来聊。
- **行为准则**：参与前请读一遍[贡献者行为准则](CODE_OF_CONDUCT.md)。

| 微信群（DSH-Plugins 社区交流 3 群） | QQ 群（群号 572549239） |
| :---: | :---: |
| <img src="screenshots/wechat-group.jpg" alt="DSH-Plugins 社区交流 3 群微信群二维码" width="200"> | <a href="screenshots/qq-group.jpg"><img src="screenshots/qq-group.jpg" alt="dsh-TUI 社区交流群 QQ 群二维码，群号 572549239，点击查看原图" width="280"></a> |

> 微信群二维码约 7 天过期一次，如遇失效请走 QQ 群（572549239），或开个 issue 提醒我们更新。

## 权限与安全边界

> [!WARNING]
> **Windows 默认高权限：** `danger-full-access`，审批 
ever`。文件与 Shell 操作不逐次确认；处理敏感或不可信内容前，请收紧 profile。

<table>
  <thead><tr><th width="112" align="left">边界</th><th align="left">规则</th></tr></thead>
  <tbody>
    <tr><td><strong>执行策略</strong></td><td>沿用 DSH profile 的沙箱与审批策略；TUI 不另设沙箱。</td></tr>
    <tr><td><strong>权限切换</strong></td><td><code>/permission</code> 或 <code>Shift+Tab</code> 选择 DSH 提供的预设。</td></tr>
    <tr><td><strong>状态校验</strong></td><td>以真实事件或读回确认；服务异常或无写路径时明确报错。</td></tr>
    <tr><td><strong>计划退出</strong></td><td>恢复进入前的权限；原预设仍可用时恢复其身份。</td></tr>
  </tbody>
</table>

<p>
  <a href="docs/architecture.md#权限与安全边界"><img src="docs/assets/readme/security-link-zh.svg" width="288" height="44" alt="查看完整权限规则与已知限制"></a>
</p>

### 致谢

- 像素鲸鱼娘的 22 帧手绘原图（Excel 逐格绘制）与闲置动画行为（摆鱼鳍、拍尾巴、入睡冒 Z、点击冒爱心）移植自 **[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)**（DeepSeek Harness Web 端鲸鱼宠物插件，作者 [@lhh010](https://github.com/lhh010)，BSD-3-Clause），感谢作者与灵感 🐋💜

### 友情链接

朋友们开发的[社区、相关项目与周边工具](docs/links.md)

## Stars

<!-- star-history:start -->
[![Star History](https://raw.githubusercontent.com/says693/dsh-TUI-693/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#says693/dsh-TUI-693&Date)
<!-- star-history:end -->


## License

[MIT](LICENSE)
