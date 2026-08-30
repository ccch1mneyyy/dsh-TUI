# dsh-TUI 文档 / Documentation

这里保存根 README 之外的完整使用与实现文档。中文文档使用无后缀文件名，
英文文档使用 `.en.md` 后缀。

This directory contains the detailed user and implementation guides kept out
of the root project page. Chinese files use the base name; English files use
the `.en.md` suffix.

| 主题 / Topic | 中文 | English |
| --- | --- | --- |
| 安装、启动与源码开发 / Installation, startup, and source development | [安装与快速开始](getting-started.md) | [Getting started](getting-started.en.md) |
| Cordis、preset、MCP 与环境变量 / Cordis, presets, MCP, and environment | [配置参考](configuration.md) | [Configuration](configuration.en.md) |
| 配色与自定义主题 / Color and custom themes | [主题系统](themes.md) | [Themes](themes.en.md) |
| 键盘、鼠标与命令 / Keyboard, mouse, and commands | [交互与命令](interaction.md) | [Interaction and commands](interaction.en.md) |
| 日常使用手册（中文，英文待补）/ Daily user guide (Chinese; English pending) | [使用说明](user-guide.md) | — |
| 运行链路、性能、安全与限制 / Runtime, performance, security, and limitations | [架构与限制](architecture.md) | [Architecture and limitations](architecture.en.md) |
| VS Code：集成终端与 companion 扩展（Claude Code 一致体验）/ VS Code: integrated terminal and companion extension (Claude-Code-identical experience) | [VS Code 使用指南](vscode.md) | [VS Code guide](vscode.en.md) |
| 贡献与开发约定 / Contributing and development rules | [贡献指南](contributing.md) | [Contributing](contributing.en.md) |
| 社区行为准则 / Code of conduct | [行为准则](../CODE_OF_CONDUCT.md) | [Code of Conduct](../CODE_OF_CONDUCT.en.md) |
| 插件准入与开发 / Plugin admission & development | [插件准入与开发指南](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) | [Plugin admission & development](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) |

## 快速入口 / Quick Links

- 中文项目首页：[README.md](../README.md)
- English project page: [README_EN.md](../README_EN.md)
- npm package: [`@deepseek-harness-tui/dsh-tui`](https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui)
- DeepSeek Harness configuration catalog:
  [official reference](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog)

文档描述当前仓库版本。配置行为最终以 `package.json`、`cordis.patch.yml`、
`src/index.ts` 和实际 DSH 组合为准。

These guides describe the current repository version. For configuration
behavior, `package.json`, `cordis.patch.yml`, `src/index.ts`, and the active DSH
composition remain authoritative.
