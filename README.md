
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

>一个美观且实用的 Claude Code 风格 TUI 插件：像素鲸鱼顶栏、双流光大字、实时工作状态行、思考流式展开、双击 Esc 时间回溯、蓝白上下文进度条 + TPS 仪表。
>零核心改动，纯插件挂载。安装插件即可启用，卸载后不会留下核心补丁。
>献给钟爱tui的各位极客们~
>
>A beautiful, practical Claude Code-style TUI plugin: pixel whale top bar, dual flowing-glow title, real-time status line, streaming thought expansion, double-Esc time rewind, blue-white context progress bar + TPS gauge.
>Zero core changes, pure plugin mounting. Install to enable; uninstall leaves no core patches.
>For all TUI-loving geeks~

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

## 核心能力

  - **终端交互**：低资源占用，长会话稳定可靠；多种主题切换，样式美观，实时显示工作状态、TPS、缓存命中率等
    推理等级、输入/输出 token 与 Git/会话信息；终端卡多行命令可经 `/settings` 折叠为首行 + 计数提示（Ctrl+O 或点击卡片展开）；全屏模式下悬停在截断的工具卡标题、用户消息或会话标题上约 600ms，浮层显示完整内容。
  - **功能全面**：`/resume` 按工作目录分类浏览、搜索与预览历史会话（左键恢复、右键弹出操作菜单；可固定常用会话——「已固定」分组置顶显示，行内 ★ 或 `Ctrl+P` 切换，持久化到 `~/.dsh-tui`），另有 `/new`、`/compact`、`/export`、`/btw`，模型热切换，原生subagent，会话fork，自动更新，输入框 `/vim` vim 编辑模式、鼠标选区编辑（拖选高亮、Shift+click 扩展、双击选词、Ctrl+C 复制选区）与全屏草稿编辑（`Ctrl+Shift+E` 或输入行 `⛶` 按钮：行号 + 当前行高亮、Enter 换行、Ctrl+Enter 发送、滚轮滚动、点击/拖选，长草稿独占整屏；`/settings` 可关）；可在vs code中[以vscode插件形式启动](docs/vscode.md)，已上架 VS Code Marketplace。
  - **扩展丰富**：原生浏览器交互，compter use等大量附属功能性扩展
  - **技能归 DSH 管理**：`/skills` 展示当前 profile、用户与项目发现的技能；dsh-TUI 不预装通用技能。



## 界面预览

<div align="center">
  <table>
    <tr>
      <td align="center" valign="middle" width="50%">
        <img src="screenshots/splash.png" alt="首屏：像素鲸鱼顶栏" width="480">
        <br>
        <strong>首屏：像素鲸鱼顶栏</strong>
      </td>
      <td align="center" valign="middle" width="50%">
        <img src="screenshots/working-line.png" alt="工作状态行 + 上下文进度条" width="480">
        <br>
        <strong>工作状态行 + 上下文进度条</strong>
      </td>
    </tr>
  </table>
</div>


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



## 插件扩展与开发指南

想为 dsh-TUI 做插件/扩展？欢迎加入生态！

- **接口与兼容性协定 / 插件开发指南**：[终端交互生态插件准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md)（准入规范、接缝、契约、验证清单）
- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)（社区插件与模板的家）
- **模板仓库**：[plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)（从模板起步，5 分钟出一个插件）
- **参考实现**：`dsh-working-activity`（实时工作状态行：TUI 槽位 + `activity/status` 会话事件双出口）



## 文档索引

| 主题 | 内容 |
| --- | --- |
| [安装与快速开始](docs/getting-started.md) | 前置条件、安装、启动、profile 生命周期、源码开发 |
| [配置参考](docs/configuration.md) | Cordis 覆盖、配置字段、Agent preset、MCP、环境变量 |
| [主题系统](docs/themes.md) | 内置主题、自动检测、自定义 JSON 主题与校验规则 |
| [交互与命令](docs/interaction.md) | 快捷键、鼠标、问卷、slash command 与会话工作流 |
| [架构与限制](docs/architecture.md) | 运行链路、渲染与持久化设计、安全边界、已知限制 |
| [VS Code 使用指南](docs/vscode.md) | 在 VS Code 集成终端运行 dsh-tui；companion 扩展 `dsh-tui-vscode` 提供与 Claude Code 官方扩展几乎一致的体验（已上架 Marketplace） |
| [贡献与开发约定](docs/contributing.md) | 贡献流程、仓库地图、构建产物、验证矩阵与修改规则 |
| [插件准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) | 接口与兼容性协定 / 插件准入规范 / 插件接缝 / 契约 / 验证清单（已并入 dsh-ecosystem-spec） |

完整的中英文索引见 [`docs/README.md`](docs/README.md)。



## 社区

- **生态组织**：[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem) —— 社区插件、模板与收录列表的家。欢迎来发插件、提创意、互相取暖 🐋
- **社区交流群**：使用问题、插件创意、功能许愿，都欢迎进来聊。

| 微信群 | QQ 群（群号 572549239） | 微信四群 |
| :---: | :---: | :---: |
| <img src="screenshots/wechat-group.jpg" alt="dsh-TUI 社区交流群微信群二维码" width="200"> | <img src="screenshots/qq-group.png" alt="dsh-TUI 社区交流群 QQ 群二维码" width="200"> | <img src="screenshots/wechat-group4.jpg" alt="dsh-TUI 社区交流四群微信群二维码" width="200"> |

> 微信群二维码约 7 天过期一次，如遇失效请走 QQ 群（572549239），或开个 issue 提醒我们更新。

## 权限与安全边界

`dsh-TUI` 不实现独立沙箱，而是使用当前 DSH profile 的文件、Shell、sandbox 与 approval 策略。仓库提供的 profile 在非 Windows 平台默认采用工作区约束与审批；Windows 当前没有对应的沙箱后端，组合会退回到 `danger-full-access` 且不弹审批。在包含敏感凭证或不可信仓库的环境中启动前，请先检查 profile 配置。

详见[权限边界与已知限制](docs/architecture.md#权限与安全边界)。

### 友情链接

朋友们开发的[社区、相关项目与周边工具](docs/links.md)

## Stars

<!-- star-history:start -->
[![Star History](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#ccch1mneyyy/dsh-TUI&Date)
<!-- star-history:end -->


## License

[MIT](LICENSE)
