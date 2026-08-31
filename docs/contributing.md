# 贡献指南

[文档索引](README.md) · [English](contributing.en.md)

感谢你考虑为 dsh-TUI 做贡献！本文档是 `@deepseek-harness-tui/dsh-tui` 的共享开发
契约，适用于在本仓库工作的所有人与编码 Agent。

## 如何贡献

- **报告 bug**：用 bug 表单提交 issue，填写版本、终端环境与最短复现步骤。
- **提功能建议**：发到 [Discussions Ideas](https://github.com/ccch1mneyyy/dsh-TUI/discussions/new?category=ideas)。
  Issues 不接受功能请求。维护者认可后会开一个 issue 跟踪实现，实现由该 issue
  的 assignee 负责。**拿到认可之前不要开始写代码**——被否的提案里已经有 OAuth、
  `/cost`、通知、插件 API、remote runtime 几套写完整才被关掉的实现。
  发出后 14 天没有维护者回应，可以直接提 PR，会被打上 `unreviewed-proposal`
  标签，按未经审阅处理。
- **提交 PR**：base 指向 `main`。保持改动聚焦——一个 PR 只做一个逻辑改动，
  标题用中文或中英对照，描述写清动机、改动点与验证方式。
  **改动代码的 PR 必须关联 issue**：描述里写一行 `Closes #<issue 号>`，或用
  侧边栏 Development 关联。CI 的 `issue-link` 组会检查，没有关联即判失败。
  纯文档改动不需要（与编译、回归同一条分流）；维护者的 release、回滚、CI
  急修等确实无 issue 可关联的场合，打 `no-issue-needed` 标签豁免。
- **请求 review 前先跑验证矩阵**：CI 运行的就是下面这些命令。
- 新功能应附带或扩展一个聚焦的回归脚本。

### 功能提案流程的生效时间

该流程只对 2026-08-24 起新建的 PR 生效。在此之前开着的 PR 按旧规则处理，
不需要补 Discussion 或跟踪 issue。

## 范围（Scope）

本文件适用于整个仓库。它是 `@deepseek-harness-tui/dsh-tui` 的共享开发契约，
适用于在本仓库工作的所有人与编码 Agent。

`@deepseek-harness-tui/dsh-tui` 是单包、纯 ESM 的 TypeScript 项目：为 DeepSeek Harness 提供
React 终端 UI 前门（通过 Cordis 挂载）。包内拥有 TUI、本地命令面
以及移植的 Ink/Yoga 渲染器；Agent、会话、模型、工具、技能、持久化与策略域由
DeepSeek Harness 拥有，TUI 只消费它们。

做大改动前，先读 `package.json`、相关 README 章节和你将要编辑的每个源文件。
优先复用仓库现有的服务边界与辅助函数，而不是引入平行的抽象。

## 仓库地图（Repository Map）

- `src/index.ts`：公共 Cordis 插件入口、配置 Schema，与对运行时插件的惰性移交。
- `src/dsh-adapter/plugin.ts`：TTY 校验、服务注册、Agent 创建/恢复、React 树挂载，以及
  终端/进程的收尾清理。
- `src/dsh-adapter/questions-answerer.ts` 与 `preset-resolution.ts`：隔离
  user-questions / agent-preset 的上游预发布兼容分派，避免把版本分支散进
  bootstrap 与 channel 动作面。注意：问卷
  "provider 座位"守卫（DUPLICATE_PROVIDER 探测 + 私有 symbol 校验，#586）只在
  rc 的 `registerProvider` 路径生效。alpha.2 的 `user-questions/request`
  waterfall 对带 agent 的请求先按 scope 过滤 listener；agentless 的 `/auth` 请求
  不带 scope carrier。按 answerer 约定，首个不调用 `next()` 委派的 eligible
  listener 会 claim 请求；但 Cordis waterfall 是 around middleware，外层 listener
  即使调用 `next()` 也能观察、替换或拒绝下游结果，`{ prepend: true }` 会把 listener
  插到队首。上游没有受支持的方法发现或保留可验证的独占 claimant，因此 legacy
  seat guard 及其告警无法在本地复现。
- `src/dsh-adapter/channel.ts`：事件到视图的投影 + 非 React 的动作面。把 DSH 会话事件
  翻译成 transcript 行，实现 submit、steer、rewind、resume、模型/preset 切换、
  本地报告及相关状态迁移。
- `src/screens/Chat.tsx`：顶层交互协调器。负责模态优先级、全局键盘、滚动/
  搜索/选区状态、slash 命令分发与聊天屏组装。
- `src/screens/StatusLine.tsx` 与 `src/screens/StatusMetrics.ts`：底部状态栏
  呈现与指标推导。
- `src/components/`：功能组件。`components/design-system/` 是主题感知原语；
  `components/messages/` 是 transcript 行；`components/questions/` 是
  `ask_user_question` 的 UI。
- `src/ui.ts`：本地渲染器、主题化 `Box`/`Text`、hooks 与公共 TUI 原语的
  首选门面。
- `src/ink/`：移植的低层 Ink 渲染器与终端实现。**敏感基础设施**：改动要聚焦，
  并附渲染器专用回归覆盖。
- `src/native-ts/yoga-layout/`：渲染器使用的移植布局引擎。
- `src/cc/`：为 Claude Code 风格 UI 适配的终端格式化与呈现辅助。
- `src/*Prefs.ts`、`src/customTheme.ts`、`src/sessionHistory.ts`：持久化的
  用户偏好与 `~/.dsh-tui` 下的本地会话元数据。
- `.agents/skills/*/SKILL.md`：仅供仓库维护者使用的项目技能，由 DSH 文件系统 provider 发现，不随 npm 包分发。
- `cordis.patch.yml`：profile 安装时使用的包级 bundle 覆盖层。行的顺序、行 ID、
  被禁用的 host 行、insert/override 语义都很关键。
- `cordis.yml`：直接 Cordis/DSH 启动的完整裸组合示例。
- `scripts/`：无头回归、复现环境、探针与诊断。运行前先读脚本头部说明。
- `lib/`：由 `src/` 生成、忽略入库并随 npm 分发的 JavaScript、声明与声明映射。
  `./invariant` 也直接使用 `lib/types/dsh-adapter/invariant.js` 的编译结果。
- `README.md` 与 `README_EN.md`：中英文用户文档。行为、配置、快捷键与限制
  必须两版同步。

## 运行时形态（Runtime Shape）

核心运行时链路：

```text
Cordis config
  -> src/index.ts
  -> src/dsh-adapter/plugin.ts
  -> DSH agent/session services
  -> src/dsh-adapter/channel.ts (session events -> Channel snapshot)
  -> src/screens/Chat.tsx
  -> src/components/*
  -> src/ui.ts
  -> src/ink/* + Yoga layout
  -> terminal ANSI output
```

职责归属在各层，不要越权：

- Agent/会话/工具事实来自 DSH 服务与持久化会话事件。
- 投影与 TUI 动作属于 `channel.ts`，不属于呈现组件。
- 交互模式与按键优先级属于 `Chat.tsx` 或当前聚焦的模态/输入组件。
- 可复用的视觉行为属于 `components/` 与主题感知原语。
- 终端协议、布局、命中测试、选区与帧差分行为属于 `ink/`。

不要仅仅为了让某个界面更好写，就在 TUI 里重新实现 DSH 域服务。通过 channel
或既有注册表缝隙去适配服务。

## 工具链（Toolchain）

- 支持 Node `^22.19 || >=24`；CI 用 Node 24。
- CI 与发布用 pnpm 11；开发也请用 pnpm。根 `package.json` 的 `packageManager`
  字段是 pnpm 版本的唯一真源，CI 与 corepack 都从这里取值。
- 干净检出安装：先 `git clone --recurse-submodules`（或在已有检出里
  `git submodule update --init --recursive`），再 `pnpm install --frozen-lockfile`。
  `vendor/dsh-std` 与 `dsh-auth` 是 workspace / `link:` 依赖，子模块为空时安装必失败。
- `pnpm-lock.yaml` 是唯一锁文件。npm 消费方不读依赖包的 lockfile，
  `package-lock.json` 已移除（见 #173 后续处理）。
- 有意改依赖时：用 `pnpm add` 更新 `pnpm-lock.yaml`，检查完整 lockfile diff，
  避免无关升级。
- 本包运行时或发布类型引用到的 `@deepseek-ai/*` 框架包（与
  `UPSTREAM_BLESSED_PACKAGES` 一一对应，含 `@deepseek-ai/schemastery`）必须同时
  是 peer 与 dev 依赖：框架包由宿主提供，profile 内运行时经
  `$DSH_HOME/profiles/node_modules` 回退树解析到宿主实例（见 #198——声明为
  runtime dependency 会在 profile 里落下真实拷贝，与宿主形成双模块实例）；
  dev 声明只为本地类型检查。新增此类引用时两组声明都要加、范围保持一致
  （verify:manifest-deps 门禁会校验）。仅测试/脚本使用的框架包
  （如 dsh-settings、dsh-tools、dsh-session-persistence-*）只需 dev 依赖，
  不要为它们声明 peer。`dsh-working-activity` 等非宿主包仍是 runtime
  dependency。历史例外已消除：`dsh-working-activity@0.2.4` 及更早版本会经其
  runtime dependency 把 `@deepseek-ai/schemastery`（连带 cosmokit）的真实拷贝
  带进 profile；0.2.5 起已 peer 化（working-activity#2），profile 内不再
  有任何框架包拷贝。保持依赖范围不低于 `^0.2.6`（0.2.6 另修复了 web 端
  WorkingLine 在未打补丁宿主上的空值守卫，working-activity#5）。
- 不要暴露、持久化或打印凭证。交互启动读取 `DEEPSEEK_API_KEY`；诊断可以
  报告是否已设置，但绝不能泄露完整值。

## 构建与生成产物（Build And Generated Files）

常规构建与类型检查关口：`pnpm build`。该命令先删除整个 `lib/`，再用
`tsc -p tsconfig.json` 把 `src/` 输出到 `lib/types/`，最后运行适配边界、上游
契约与 patch surface 门禁。`prepare` 生命周期只服务**源码检出场景**的自举
编译（vendor 子模块缺失时快速失败，见 scripts/prepare-guard.mjs）；Git URL
依赖安装自 vendoring（#308）起三重阻断（workspace 依赖/子模块/pnpm ≥11
prepare 白名单），不受支持，请装 registry 包。本地与 CI 使用显式命令，不
依赖 pnpm 是否隐式执行根包生命周期。

生成产物规则：

- 改 `src/`，**绝不直接改 `lib/`**。
- 任何源码改动后运行 `pnpm build`，但不要提交 `lib/` 下的生成结果。
- 干净编译会先删除整个 `lib/`，源模块重命名或删除后不会留下过期输出。
- 运行 `pnpm verify:package` 检查 `main`、`types`、`bin` 与 `exports` 的所有目标
  都进入 npm tarball，并 smoke-import 主入口和 invariant 入口。
- 纯文档、纯 workflow、纯 YAML 改动不需要重建（除非同时改了 TypeScript 输入）。
- 使用 `--ignore-scripts` 安装 Git URL 会跳过 `prepare`，因而不受支持；registry
  包已经包含编译结果，不依赖消费者执行生命周期脚本。

`scripts/build.sh` 是面向本地 DeepSeek Harness 源码检出的备用构建器（定位 DSH
检出并重连依赖），不是本独立仓库的默认构建命令。

## 验证（Verification）

仓库没有根级 `test` 或 `lint` 脚本；不要声称跑过它们。TypeScript 构建是通用
静态关口，随后是聚焦的可执行回归。

CI 在安装后运行：

```sh
pnpm compile                               # 从干净目录生成运行时
test -f lib/types/index.js
pnpm verify:build                          # 构建门禁，不重复编译
pnpm verify:package                        # npm tarball 与入口 smoke test
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

改动共享渲染、`Chat`、提示/问卷布局、工具卡、主题原语或 Ink core 时，三个
CI 回归都要跑。窄改动还要跑最近的聚焦脚本：

| 改动区域 | 聚焦验证 |
| --- | --- |
| 通用无头屏幕组装 | `pnpm smoke` |
| Channel submit/steer/pending 行为 | `node scripts/verify-submit.mjs` |
| 提示队列行为 | `node scripts/verify-queue.mjs` |
| Goal/todo 投影与渲染 | `node scripts/verify-channel-goal-todo.mjs` + `node scripts/verify-goal-todo.mjs` |
| Compaction 与折叠 transcript 行 | `node scripts/verify-compact.mjs` |
| 压缩 × 会话切换生命周期（取消先于 fork 快照、persistence 分类提示） | `node --import tsx/esm scripts/verify-compact-switch.tsx` |
| 主题加载、持久化与运行时插件接缝 | `node --import tsx/esm scripts/verify-themes.mjs`、`node --import tsx/esm scripts/verify-runtime-themes.ts` |
| 滚动/粘底行为 | `node scripts/verify-scroll.mjs`、`node scripts/verify-resticky.mjs` 及对应 `repro-*` 环境 |
| 计划评审长正文（`exit_plan_mode` 窗口化 + 滚轮） | `node --import tsx/esm scripts/verify-plan-review-scroll.tsx` |
| 全屏复制即选区 | `node scripts/verify-copy-on-select.mjs` |
| 组件级鼠标拖拽协议（目标捕获、事件冒泡、点击/选区兼容与中断收尾） | `node --import tsx/esm scripts/verify-drag-protocol.tsx` |
| 鼠标指针事件管线（滚轮坐标/修饰位、点击/hover 派发、越界 clamp、指针态重置） | `node --import tsx/esm scripts/verify-pointer-events.ts` |
| Hover 事件性能（兴趣边界完整、无兴趣矩形快路径、帧边界/多 root 失效） | `node --import tsx/esm scripts/verify-hover-coalesce.tsx` |
| 输入框鼠标选区编辑（拖选/Shift+click/双击选词/删除替换/Esc 分层/Ctrl+C 复制、CJK 宽字符与 fold 侧钳制） | `node --import tsx/esm scripts/verify-input-selection.tsx` |

多数用普通 `node` 调用的脚本 import `lib/types/`——先跑 `pnpm build`。import
TypeScript 源的脚本在头部声明 `node --import tsx/esm <script>` 形式。不要凭
扩展名推断输入层：例如 `verify-themes.mjs` 其实通过 tsx import `src/`。

部分脚本是取证/交互工具而非有界测试：堆/泄漏脚本、PTY 探针、回放捕获、
性能探针与 `scripts/run.ts` 可能依赖特定 OS、终端、原生依赖、DSH 检出或长时
进程。读头部与前置条件，不要把 `scripts/` 当套件全跑。

终端可见改动：无头断言必要但不充分。环境可用时，在 inline 与 fullscreen 两种
模式、窄终端宽度下手动走一遍受影响流程：启动、resize、滚动、输入、取消与干净
退出。Windows ConPTY、tmux、OSC 剪贴板与同步输出有独立路径，改动它们时用对应
探针。

`pnpm tui` 调用 `scripts/run.ts`，它假定包位于 DeepSeek Harness monorepo
（`apps/cli` + `packages/*`）布局内，不是可移植的独立冒烟命令。端到端集成检查：
把插件装进 DSH profile，在真实 TTY 用所需凭证运行 `dsh --profile dsh-tui`。

## TypeScript 与风格（TypeScript And Style）

- 包是 ESM。TypeScript 相对导入用 `.js` 后缀（如
  `import { Chat } from './screens/Chat.js'`）。保持此规则。
- 仓库自写 TypeScript 遵循现有风格：两空格缩进、单引号、无分号、多行结构
  尾逗号。移植的 Ink 文件可保留上游的 tab 或引号风格，不要批量格式化。
- 纯类型依赖优先 `import type`。
- 不要因为 `tsconfig.json` 放宽了 `noImplicitAny` 就引入 `any`。那些放宽是
  为了编译移植的 Ink core，不能成为新应用代码的质量基准。用 `unknown` 并收窄，
  或在外部缝隙定义小型结构化接口。
- 周边 API 用只读数据的地方保持只读。状态变更放在 channel/store 实现内，
  不要在组件里改值。
- 导出的 API 用简洁 JSDoc 说明契约与非显然的不变量，不要逐行解释机制。
- 避免一次性抽象与无关重构。只有一个调用点且不阐明真正不变量的琐碎辅助函数
  就地内联。
- 保护环境敏感 import 的初始化顺序。`FORCE_COLOR`、`NODE_ENV`、终端能力标志
  常在模块求值时读取；把 import 移到它们初始化之前会无类型错误地改变行为。

## 架构不变量（Architectural Invariants）

### Cordis 生命周期与配置

- 保持 `src/index.ts` 是小的公共插件契约、`src/dsh-adapter/plugin.ts` 是运行时实现。
  除非任务有意改插件加载契约，否则保留惰性移交。
- 资源通过 Cordis 注册，用 `ctx.effect` 或既有单一退出漏斗清理。渲染失败必须
  响亮且非零退出；正常退出必须在进程退出前恢复终端状态。
- `cordis.patch.yml` 叠加在 `dsh-base` 上。不要重复 base 已挂载的服务行。
  区分 ID 覆盖与 `insert`，一个服务依赖另一个时保持顺序。
- profile 覆盖会替换整个 `config` 块。文档展示覆盖时，包含替换后必须存活的
  每个键。
- 新增或重命名插件选项时，同步更新 `src/index.ts` 的 `Config` 接口与 Schema、
  运行时消费、`cordis.patch.yml` 与 `cordis.yml` 的相应行，以及双 README。

### 会话与通道状态

- 持久化的 DSH 会话事件日志是 transcript 真源。行从事件回放/投影而来；不要
  插入可能与持久化分歧的乐观助手/工具事实。
- 保留事件顺序、序列锚点与 call-ID 匹配。rewind、resume、折叠、工具结果关联
  与导出都依赖它们。
- 每个可观察的 channel 变更必须走恰当的同步或帧合并 emitter，让 `version`
  推进、订阅者被通知。
- 保持长会话内存有界。不要在没有实测替代方案时移除 transcript 折叠、回放
  合并、虚拟化或缓存上限。
- resume、rewind、模型切换、preset 切换等 Agent 变更必须一起重置所有会话级
  投影。审计行、goals、todos、标题、pending 消息、指标与已加载上下文的陈旧
  状态。
- 通过已挂载的 DSH 服务与注册表解析 agent/model/tool/preset 能力。不要猜测
  外部 API 形状；改集成时查看已安装包的类型。

### 交互与命令

- 按键优先级是行为，不是偶然的控制流。聚焦的问卷或模态先于全局处理器消费
  按键；鼠标文本选区先于 rewind/clear 消费 Escape；提示词只在无浮层时拥有
  文本编辑。
- 不要在单个组件里硬编码新快捷键就完事。同步更新相关帮助 UI 与双 README
  快捷键表，并为与既有模式的冲突新增或扩展回归。
- 本地 slash 命令在 `src/commands.ts` 声明、`Chat.tsx` 分发；注册表命令运行时
  合并。新增命令时同步更新声明、分发、帮助/文档与 i18n 描述（`src/i18n.ts` 的
  `cmd-desc-<name>`，只写 zh——en 回退声明原文）。
- 技能命令不进本地名单：DSH 发现的 user-invocable 技能经注册表合并为直调命令，
  命令名必须是可解析的 kebab-case，且不能与本地命令撞名。
- `ask_user_question` 必须经 `QuestionStore` 串行化；并发问题刻意 FIFO 呈现，
  结束后汇总。

### 终端渲染

- 优先用 `src/ui.ts` 导出的主题原语与 hooks。只有门面刻意不暴露的行为才深入
  `src/ink/`。
- 终端宽度是显示单元宽度，不是 JS 字符串长度。考虑 ANSI 转义、组合字符、
  emoji 与东亚宽字符；用仓库的宽度/切片/换行/ANSI 辅助函数。
- 保持帧输出缓冲、常规运行安静。TUI 活动期间不要加 `console.log` 或 stdout
  诊断。用 opt-in 的 stderr/调试路径（如 `DSH_TUI_DEBUG`）或既有
  `DSH_TUI_RENDER_LOG` 帧捕获。
- 在成功、错误、中断与收尾时都保持 raw 模式、光标、alt-screen、同步输出、
  鼠标、焦点与终端查询的清理。
- 避免渲染期无界集合或每 token/每帧分配。流式会话长命，本仓库对先前的 OOM
  与滚动性能失败有明确回归。
- 布局改动不得让 transcript 内容挤掉输入行与状态行。改动相关路径时演练
  resize 风暴、超长无断内容、流式行、上滚状态与粘底恢复。
- 平台检测保持窄。Windows Terminal/ConPTY、WSL、tmux、VS Code 与支持或不支持
  truecolor/DEC 2026 的终端走不同协议路径。

### 偏好、主题与文件

- 遵循既有可配置偏好优先级：显式部署配置或环境覆盖 > 持久化用户选择 >
  检测/默认值。改变该顺序要记录。
- 用户数据持久化在既有 `~/.dsh-tui` 位置下。校验并安全解析外部 JSON；损坏的
  可选状态应警告或回退，而不是让 TUI 崩溃。
- 把主题名、插件主题 descriptor 与文件内容当不可信输入。保留路径包含检查、插件
  ID 约束与损坏主题文件的全有或全无校验；插件注册必须随 activation 清理。
- 主题新增必须完整覆盖 `Theme` 契约与每个内置色板。组件用语义主题键，不要用
  孤立的字面颜色。运行时主题通过 `tuiThemes` 接缝接入，不要让插件直接改写
  `~/.dsh-tui/themes/` 或绕过现有扩展服务。

## 跨文件修改清单（Cross-File Change Checklist）

| 改动 | 需要同步 |
| --- | --- |
| 插件配置或环境行为 | `src/index.ts`、运行时消费、`cordis.patch.yml`、`cordis.yml`、`README.md`、`README_EN.md` |
| Slash 命令或快捷键 | `src/commands.ts`、`src/screens/Chat.tsx`、帮助/输入组件、双 README、相关技能映射/测试 |
| 主题契约、插件接缝或持久化主题行为 | `src/theme.ts`、`src/themeCatalog.ts`、`src/dsh-adapter/themes.ts`、所有色板、主题 provider/picker、自定义主题解析器、主题验证、双 README、插件文档 |
| 会话/channel 行为 | `src/dsh-adapter/channel.ts`、受影响的 UI 投影、编译产物、聚焦 channel/回放回归 |
| 渲染器/布局行为 | `src/ink/` 或 Yoga 源、编译产物、CI 回归、聚焦滚动/resize/PTY 探针 |
| 技能发现或呈现 | DSH adapter、slash 命令合并、`/skills` 与相关回归；项目维护技能放 `.agents/skills/` 且不得加入 npm 包 |
| 用户可见的文档化行为 | 中英文 README，外加适用的配置注释/帮助文本 |
| 包版本或依赖 | `package.json`、`pnpm-lock.yaml`、适用时的生成/发布产物；不要顺手搅动旧 npm 锁文件 |

## Git 与发布安全（Git And Release Safety）

- 工作树可能含有他人的改动。编辑前检查 `git status` 与相关 diff，保留无关
  改动，绝不丢弃不是你创建的工作。
- 不要运行破坏性清理命令（`git reset --hard`、`git checkout .`、
  `git clean -fd`）。不要用 `git stash` 隐藏他人会话的工作。
- 只暂存显式路径，绝不在共享工作树用 `git add .` 或 `git add -A`。
- 未经用户要求，不 commit、不打 tag、不 push、不发布、不建 Release。
- 发布由 tag 驱动：`.github/workflows/publish.yml` 要求 `v*` tag 与
  `package.json` 版本完全一致，随后构建、跑聚焦回归并发布 npm。版本变更与
  tag 是发布操作，不是日常清理。
- Release note 带贡献者署名：建 GitHub Release 用
  `gh release create vX.Y.Z --notes-file notes.md --generate-notes`——手写摘要
  在前，GitHub 在后面自动追加 What's Changed（PR 标题 + 作者 + 链接）、
  New Contributors 与 Full Changelog；`.github/release.yml` 从自动清单里排除
  bot。手写摘要中来自外部贡献者的条目在末尾标 `（#PR号 by @用户名）`，维护者
  自己的条目不标；裸写 `#123` 与 `@user`，GitHub 渲染成链接。
- 移交代码改动前检查 `git diff --check`、源码 diff、生成 diff 与 `git status`，
  并如实报告跑了哪些验证、哪些平台/凭证相关的检查没跑。
