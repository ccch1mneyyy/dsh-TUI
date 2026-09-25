# 文档索引 / Documentation index

根 README 只列"有什么"，细节都在这里。中文文档没有后缀，英文文档是 `.en.md`。
The root README lists what ships; the details live here. Chinese files have no suffix, English files use `.en.md`.

## 上手 / Get started

| 文档 / Doc | 中文 | English | 讲什么 / What it covers |
| --- | --- | --- | --- |
| 安装与快速开始 / Install & run | [getting-started.md](getting-started.md) | [getting-started.en.md](getting-started.en.md) | 从安装、启动到排障。 |
| VS Code | [vscode.md](vscode.md) | [vscode.en.md](vscode.en.md) | 在 VS Code 里跑，配合扩展与 IDE 选区。 |

## 日常使用 / Using it

| 文档 / Doc | 中文 | English | 讲什么 / What it covers |
| --- | --- | --- | --- |
| 使用说明 / User guide | [user-guide.md](user-guide.md) | [user-guide.en.md](user-guide.en.md) | 键位、命令、会话工作流与设置。 |
| 交互与命令 / Interaction & commands | [interaction.md](interaction.md) | [interaction.en.md](interaction.en.md) | 键位、鼠标、问卷审批与 slash 命令。 |
| 主题系统 / Themes | [themes.md](themes.md) | [themes.en.md](themes.en.md) | 内置主题、自动检测与自定义主题。 |

## 配置 / Configuration

| 文档 / Doc | 中文 | English | 讲什么 / What it covers |
| --- | --- | --- | --- |
| 配置参考 / Configuration | [configuration.md](configuration.md) | [configuration.en.md](configuration.en.md) | 覆盖层、TUI 开关、Agent preset 与 MCP。 |

## 实现 / Internals

| 文档 / Doc | 中文 | English | 讲什么 / What it covers |
| --- | --- | --- | --- |
| 架构与限制 / Architecture & limitations | [architecture.md](architecture.md) | [architecture.en.md](architecture.en.md) | 运行链路、性能、安全边界与已知限制。 |
| 会话挂载运行时 / Session mount runtime | [session-mount-runtime.md](session-mount-runtime.md) | [session-mount-runtime.en.md](session-mount-runtime.en.md) | 多 TUI 占用规则与本机账本。 |

## 插件 / Plugins

| 文档 / Doc | 中文 | English | 讲什么 / What it covers |
| --- | --- | --- | --- |
| 插件准入与开发 / Plugin admission & development | [外部规范](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) | [spec](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) | 接缝、契约与验证清单。 |
| 插件速览 / Plugin overview | [plugins.md](plugins.md) | [plugins.en.md](plugins.en.md) | 生态入口与接缝稳定性分级。 |

## 参与 / Contributing

| 文档 / Doc | 中文 | English | 讲什么 / What it covers |
| --- | --- | --- | --- |
| 贡献与开发约定 / Contributing | [contributing.md](contributing.md) | [contributing.en.md](contributing.en.md) | 贡献流程、仓库地图与验证矩阵。 |
| 社区管理框架 / Community management | [community-management.md](community-management.md) | [community-management.en.md](community-management.en.md) | 社区入口、角色与提案流程。 |
| 项目路线图 / Roadmap | [roadmap.md](roadmap.md) | [roadmap.en.md](roadmap.en.md) | 公开目标、阶段、退出条件。 |
| 行为准则 / Code of conduct | [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | [CODE_OF_CONDUCT.en.md](../CODE_OF_CONDUCT.en.md) | 参与社区的言行准则。 |

## 快速入口 / Quick links

- 中文项目首页 [README_ZH.md](../README_ZH.md) · English project page [README.md](../README.md)
- npm 包：[`@deepseek-harness-tui/dsh-tui`](https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui)
- DeepSeek Harness 配置目录：[官方参考](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog)

> 文档描述当前仓库版本；配置行为以 `package.json`、`cordis.patch.yml`、`src/index.ts` 与实际 DSH 组合为准。
> These guides describe the current repository version; configuration behavior is governed by `package.json`, `cordis.patch.yml`, `src/index.ts` and the active DSH composition.
