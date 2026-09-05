# AGENTS.md

dsh-TUI（`@deepseek-harness-tui/dsh-tui`）通过 Cordis 挂载终端界面。DeepSeek Harness 拥有 Agent、会话、模型、工具、技能、持久化与策略域，本包消费这些服务。

## 按任务读文档

- 改动前读 [docs/contributing.md](docs/contributing.md) 中相关章节：这是共享开发契约，包含仓库地图、工具链、验证矩阵与跨文件同步清单。
- 改上游集成、依赖版本或 `cordis.patch.yml` 时读 [ADAPTER.md](ADAPTER.md)：它定义 adapter 边界、peer/dev 依赖契约与 patch 快照更新流程。
- 调整职责或运行链路时读 [docs/architecture.md](docs/architecture.md)。改 `dsh-ecosystem-spec/` 时先读其 CONTRIBUTING 与治理文档。
- 运行 `scripts/` 中的脚本前读其头部：输入可能是 `src/` 或编译后的 `lib/types/`，取证、PTY 和性能工具也不一定是有界测试。

## 工作方式

- 按用户当前目标完成工作：审查请求默认给发现；明确要求修复时继续实施和验证；不要把修复变成只写报告。缺少会影响结果的关键信息时再提问，已有上下文和授权继续有效。
- 编辑前检查工作树与相关 diff，保留他人的改动。先读受影响实现与调用方，复用现有服务和辅助函数；只有当前需求确实需要时才增加抽象。
- 指引或 skill 与用户要求冲突时按用户要求执行；若仍有必须暂停的具体约束，指出来源和缺少什么，继续不受影响的工作。

## 常用工程约束

- **上游边界**：官方 `@deepseek-ai/*` 只允许在 `src/dsh-adapter/` 内 import。UI 经 adapter facade 消费上游，不重实现 DSH 域服务。
- **职责**：`src/index.ts` 保持公共配置与惰性入口；`src/dsh-adapter/plugin.ts` 负责运行时挂载与收尾；`src/dsh-adapter/channel.ts` 负责投影和 TUI 动作；`src/screens/Chat.tsx` 协调交互与按键优先级；`src/ink/` 负责终端协议、布局与帧差分。
- **会话真源**：transcript 从持久化的 DSH 会话事件投影，保留事件顺序、序列锚点与 call-ID 匹配；不要插入可能与持久化分歧的乐观助手/工具事实。
- **生命周期**：资源经 Cordis 注册，用 `ctx.effect` 或既有单一退出漏斗清理。渲染失败须报错并非零退出；退出时恢复 raw 模式、光标、alt-screen、同步输出、鼠标与焦点状态。
- **终端**：优先使用 `src/ui.ts` 的主题原语和仓库的显示宽度、切片、换行辅助函数，考虑 ANSI、组合字符、emoji 与东亚宽字符。TUI 活动期间保持 stdout 安静，诊断用 opt-in 的 stderr/调试路径。
- **源码**：只编辑 `src/`，不手改或提交生成的 `lib/`。TypeScript 使用 ESM、相对导入 `.js`、`import type` 与 `unknown` 收窄；遵循周边风格，不批量格式化移植的 Ink/Yoga 文件。
- **文档**：用户可见的行为、配置、快捷键与限制同步到 `README.md` 与 `README_EN.md`；其他中英文文档修改成对同步。

## 验证与交付

- 代码或类型改动跑 `pnpm build` 与 `pnpm verify:package`。按共享开发契约的验证矩阵选择回归；共享渲染、Chat、问卷、工具卡、主题原语或 Ink core 的行为改动须跑全部三个 CI 回归。
- 终端可见改动在无头断言之外，环境可用时在 inline、fullscreen 和窄终端宽度下演练受影响流程。
- 纯文档或普通注释改动按共享开发契约检查内容、链接及代码未变的证据；不为改写文字新增行为测试。CI 的路径分流与本地验证范围分开判断。
- 仓库没有根级 `test` 或 `lint` 脚本。验证通过后，只有新改动、失败或未解决的风险才需要扩大或重复检查；交付时如实报告验证结果与限制。
- 只暂存显式路径；不运行破坏性清理命令，不丢弃或隐藏他人的工作。commit、push、tag、发布与 Release 遵循用户在本次会话中的授权；发布版本与 tag 规则见共享开发契约。
- 密钥只能报告是否已设置，不输出值；交互启动读取 `DEEPSEEK_API_KEY`。

## 维护指引

`CLAUDE.md` 是指向本文件的符号链接，编辑真身。常用约束留在这里，详细规则留在权威文档，并说明何时读取。`.agents/skills/` 仅供仓库维护者使用，不随 npm 分发；skill 聚焦任务专有的判断与步骤，不重复引入全局约定。
