# 总览

## 项目定位

dsh-cc-tui 是一个 Cordis 插件，为 DeepSeek Harness 的 agent 提供 Claude Code
风格的终端 TUI 前门。插件自身的自述（`src/plugin.ts:26-27`）：

> Claude Code style interactive TUI front door for DeepSeek Harness agents.

它不拥有 Agent、会话、模型、工具、持久化与策略域——这些由 DeepSeek Harness
（DSH）提供，TUI 只消费它们（`docs/contributing.md:18-21` 同口径）。插件
"attaches to (or creates) one agent, renders a chat transcript from the agent's
session log and live `session/event` records, and submits user turns through
`Agent.followup`"（`src/plugin.ts:29-33`），与 `dsh-jsonrpc` 属于同一类
client-driver 前门。

插件自带 TUI、本地命令面以及移植的 Ink/Yoga 渲染器；渲染内核
`src/ink/` 是 Claude Code 内部 ink fork 的移植（归属证据见
[origin.md](origin.md)，结构地图见 [ink-core.md](ink-core.md)）。

## 运行链路

从配置到终端的主链路（各环节文件为源码根目录相对路径）：

```text
cordis.yml / cordis.patch.yml（组合层）
  -> src/index.ts（插件契约与 Schema，入口保持轻量）
  -> src/plugin.ts（TTY 检查、语言解析、服务装配、Agent 创建/恢复、React 挂载、退出清理）
  -> DSH agent / session / tool services（@deepseek-ai/dsh-* 官方包）
  -> src/channel.ts（session/event 投影为 transcript；submit/steer/resume/rewind/model 动作面）
  -> src/screens/Chat.tsx（键盘与模式编排、slash 命令分发）
  -> src/components/*（视图与 design-system）
  -> src/ui.ts（主题化 renderer facade）
  -> src/ink/* + src/native-ts/yoga-layout（布局、终端协议、差分输出）
  -> ANSI 终端
```

该链路与 `docs/architecture.md:5-18` 的旧描述一致，且已在基线代码中重新验证：
入口 `src/index.ts` 导出插件契约并动态委托 `src/plugin.ts` 的 `apply`
（[lifecycle.md](lifecycle.md)）。

## 分层与模块边界

| 模块 | 所有权 |
| --- | --- |
| `src/index.ts` | Cordis 插件名称（cc-tui）、注入声明、Config 接口与 Schema；保持入口轻量并延迟加载 runtime |
| `src/plugin.ts` | TTY 校验、语言解析、userQuestions/技能/stderr 守卫装配、Agent 创建/恢复、React 挂载、统一退出清理 |
| `src/channel.ts` | 将 DSH 持久化事件投影为 transcript；提供 submit、steer、resume、rewind、model/preset 等动作；不把 React 本地数组当作对话真相 |
| `src/screens/Chat.tsx` | 模态优先级、全局按键、滚动/搜索/选择状态、slash 命令分发 |
| `src/components/` | 功能组件与 design-system（`components/design-system/` 主题感知原语、`components/messages/` transcript 行、`components/questions/` 问卷 UI）；不直接拥有 Agent 或 session 真相 |
| `src/screens/StatusLine.tsx` 与 `src/screens/StatusMetrics.ts` | 底部状态栏呈现与指标推导 |
| `src/ui.ts` | 主题化 `Box`/`Text`、render、选择、滚动等公共 facade |
| `src/ink/` | 移植的 Ink renderer、终端协议、事件、选择与 Yoga 桥接；敏感底层设施 |
| `src/native-ts/yoga-layout/` | 纯 TypeScript yoga 移植（`src/native-ts/yoga-layout/index.ts:2`） |
| `src/cc/` | 为 Claude Code 风格 UI 适配的终端格式化与呈现辅助 |
| `src/*Prefs.ts`、`src/customTheme.ts`、`src/sessionHistory.ts` | 持久化用户偏好与 `~/.dsh-cc` 下的本地元数据 |
| `src/commands.ts` | 本地 slash 命令声明（39 条内置）与解析辅助 |
| `.agents/skills/*/SKILL.md` | 仅供仓库维护者使用的项目技能，由 DSH 发现，不随 npm 分发 |
| `cordis.patch.yml` | profile bundle 覆盖层（29 个顶层覆盖 + 4 行 insert）；行的顺序、行 ID、insert/override 语义都很关键 |
| `cordis.yml` | 直接 `dsh --config` 启动的裸组合示例（24 个服务行） |
| `scripts/` | 无头回归、复现环境、探针与诊断（repro 10 个 / verify 18 个，glob 前缀计数） |
| `lib/types/` | `tsc` 入库产物（构建产物，本审计不阅读内容） |

## 数据流：Session 是真源

`channel.ts` 不把 React 本地数组当作对话真相，transcript 行全部从持久化的
DSH 会话事件日志派生（`src/channel.ts:110-114`）：

> The DSH session log is the source of truth: rows are derived from
> `session/event` records (and the initial `agent.session.events` replay),
> never from optimistic local state.

会话事件日志承担：初始历史回放与增量流式事件、assistant/reasoning/tool 行
的关联与 sequence anchor、rewind 的 turn 边界、resume/export/compact/fork
后的重建。Channel 只保留适合 TUI 的投影：长会话超过窗口后旧行折叠为短预览，
完整内容仍在 session log 中；工具结果按 `callId` 关联，不按数组位置猜测
（`src/channel.ts:34-58` ToolRow 结构）。

## 源码分布

`src/` 共 209 个文件（程序化计数，Glob 按目录分组）：`src/ink/` 103（移植
内核，见 [ink-core.md](ink-core.md)）、`src/components/` 53、
`src/utils/` 14、`src/cc/` 8、`src/screens/` 3、`src/native-ts/` 2
（yoga-layout）、`src/bootstrap/` 1、`src/hooks/` 1（useBlink.ts）、
`src/types/` 1（cc.d.ts 类型 shim）、src 根 23。`scripts/` 计数同上：
repro-* 10 个、verify-* 18 个（glob 前缀匹配）。npm 包 exports 6 项
（`.`、`./working-activity`、`./invariant`、`./cordis.patch.yml`、
`./package.json`、`./src/*`，package.json:9-25）。

`src/bootstrap/` 仅含遥测空桩（state.ts），不参与启动流程（见
[lifecycle.md](lifecycle.md#bootstrap-目录)）。

## 版本与基线关系

- 当前 HEAD 为 `b2f4087`（git describe：v0.4.1-48-gb2f4087），即 v0.4.1 tag
  （eeca418）之后 48 个提交。
- v0.4.1 tag 不包含 pr-55（/rewind 命令 + /new 一次生效）与 pr-61（MCP
  stderr 接管）——两者均在其后、当前基线已包含。
- v0.3.5（tag 9e563af）是直接祖先，与基线差异 184 个文件、无删除（旧版本文档
  仅在 [unknowns.md](unknowns.md) 作为参考线索使用，行号与存在性均已重新验证）。

相关文档：[lifecycle.md](lifecycle.md)（装配与启动序）、
[ink-core.md](ink-core.md)（渲染内核）、[origin.md](origin.md)（来源归属）、
[unknowns.md](unknowns.md)（未验证清单）。
