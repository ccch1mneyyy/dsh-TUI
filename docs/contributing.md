# 贡献指南

[文档索引](README.md) · [English](contributing.en.md)

感谢你考虑为 dsh-TUI 做贡献！本文档是 `@deepseek-harness-tui/dsh-tui` 的共享开发
契约，适用于在本仓库工作的所有人与编码 Agent。

## 如何贡献

- **报告 bug**：用 bug 表单提交 issue，填写版本、终端环境与最短复现步骤。
  报告不预留实现，也不授权开 PR。
- **提功能建议**：发到 [Discussions Ideas](https://github.com/ccch1mneyyy/dsh-TUI/discussions/new?category=ideas)。
  - Issues 不接受功能请求。
  - 维护者认可后开 issue 跟踪实现，由该 issue 的 assignee 负责。
  - **拿到认可前不要开始写代码**。被否的提案里已有 OAuth、`/cost`、
    通知、插件 API、remote runtime 几套写完整才被关掉的实现。
  - Discussion、issue、评论或「维护者同意了」的转述，
    都不构成开 PR 的许可。
- **提交 PR**：只有仓库 write/admin/maintain 协作者，或
  [`.github/APPROVED_CONTRIBUTORS`](../.github/APPROVED_CONTRIBUTORS) 名单中的用户，
  可以提交实现 PR。
  - 其余人的实现 PR 会被 `pr-gate` 自动关闭，不论体积、标题、测试结果，
    也不论是人还是 Agent 写的。
  - 名单由维护者按既有信任添加，不是申请制；不要开 issue 或 Discussion 申请加入。
  - 名单只允许提交 PR，不授予 write，也不预审功能范围。
  - 维护者 reopen 一次已关闭的 PR 可作为例外；其他人 reopen 会被再次关闭。
  - base 指向 `main`。保持改动聚焦：一个 PR 只做一个逻辑改动。
    标题用中文或中英对照，描述按 [PR 模板](../.github/PULL_REQUEST_TEMPLATE.md)
    写清动机、改动形状与验证方式；Agent 发 PR 使用 `.agents/skills/pr`。
  - **改动代码的 PR 必须关联 issue**：描述里写一行 `Closes #<issue 号>`，
    或用侧边栏 Development 关联。CI 的 `issue-link` 组会检查，没有关联即判失败。
  - CI 判定为纯文档的改动不需要关联（路径分流见“验证”）。
    维护者的 release、回滚、CI 急修等确实无 issue 可关联时，
    打 `no-issue-needed` 标签豁免。
- **请求 review 前先跑验证矩阵**：CI 运行的就是下面这些命令。
- 新功能应附带或扩展一个聚焦的回归脚本。

开实现 PR 之前，确认当前 GitHub 账号是 write 协作者或出现在
`.github/APPROVED_CONTRIBUTORS`。两者都不是就拒绝开 PR，引导去 bug 表单或
Discussions。人不能用「私下批准」、关联 issue 或粘贴维护者评论来绕过。

### 贡献纪律

适用于所有贡献者与编码 Agent，是提交前的自律基线，与门禁、CI 互补：

- **贡献以实质价值衡量**：不以提交数、PR 数或代码行数计贡献。不做拆分
  凑数式提交；改动保持最小必要、代码精简，不引入冗余封装与重复实现
  让代码膨胀。
- **AI 生成代码必须人类把关**：允许 AI 辅助开发，但禁止全自动流入
  `main`——任何改动必须经人类审查与人类合并决策（ruleset 要求的
  approving review 即为此设）；CodeRabbit 等 bot 审查只是第二双眼睛，
  不替代人工。
- **AI 辅助开发尽量用强模型**：允许 vibe coding 式快速迭代，但尽量选用
  能力较强的模型：弱模型输出更容易代码膨胀、幻觉 API 与隐性回归，
  返工成本高于模型差价。
- **PR 前必须本地实际验证**：跑过改动面对应的构建与聚焦回归（见
  「验证」），终端可见改动在真实终端走过受影响流程。没跑的检查如实
  写进 PR 的 Verification 段，不把「应该能过」写成「已验证」。

### 门禁与提案流程的生效时间

功能提案流程只对 2026-08-24 起新建的 PR 生效。PR 白名单门禁只对门禁合入后
新开（或被 reopen）的 PR 生效。在此之前开着的 PR 按旧规则处理，不会被追溯关闭，
也不需要补 Discussion 或跟踪 issue。

### 合并队列（Merge Queue）

`main` 上的合并由 [Mergify](https://mergify.com) 的合并队列执行，配置在
[`.mergify.yml`](../.mergify.yml)：PR 拿到 1 个 approving review 后自动入队，队列把它
更新到最新 `main`、在临时 PR 上重跑 CI，绿了自动合并。合并条件由 base 分支上的
ruleset 注入（批准、`ci-gate`、评论已解决、批准最后一次推送），与手动合并同一把尺。
队列不放水，也没有任何绕过批准的通道；急修仍然只有 admin 能做的
`gh pr merge --admin`。

队列只收 base 指向 `main` 的 PR：stacked PR 在 retarget 到 `main` 之前不会入队。
已经批准但想先别合，打 `on hold`。队列创建的临时 PR（`mergify/merge-queue/*`）是
draft、只跑一次 CI 就关，`pr-gate` 与 `issue-link` 都按机器人放行。

配套的 ruleset 决定：`main` 的「要求分支必须最新」已关闭。它和队列冲突——队列测的是
临时 PR，GitHub 会认为原 PR「不是最新」而拒绝合并，而「在最新 `main` 上测出合并后的
状态」正是队列要替你做的事。批准、`ci-gate`、评论已解决这几条仍由 GitHub 强制执行，
为此 Mergify **不在**任何豁免名单里。

## 范围（Scope）

本文件适用于整个仓库。它是 `@deepseek-harness-tui/dsh-tui` 的共享开发契约，
适用于在本仓库工作的所有人与编码 Agent。

`@deepseek-harness-tui/dsh-tui` 是单包、纯 ESM 的 TypeScript 项目：
为 DeepSeek Harness 提供 React 终端 UI 前门（通过 Cordis 挂载）。

- 包内拥有 TUI、本地命令面以及 Ink/Yoga 渲染器。
- Agent、会话、模型、工具、技能、持久化与策略域由 DeepSeek Harness 拥有，
  TUI 只消费它们。

做大改动前，先读 `package.json`、相关 README 章节和你将要编辑的每个源文件。
优先复用仓库现有的服务边界与辅助函数，而不是引入平行的抽象。

## 仓库地图（Repository Map）

- `src/index.ts`：公共 Cordis 插件入口、配置 Schema，与对运行时插件的惰性移交。
- `src/dsh-adapter/plugin.ts`：TTY 校验、服务注册、Agent 创建/恢复、React 树挂载，以及
  终端/进程的收尾清理。
- `src/dsh-adapter/oauth/`：pi-ai 订阅 OAuth 的 provider 路由、`/auth` 命令、
  凭据存储与 user-questions 桥接；DeepSeek 账号授权委派给宿主服务，
  经 `src/oauth.ts` 子入口挂载。
- `src/dsh-adapter/questions-answerer.ts` 与 `preset-resolution.ts`：
  隔离 user-questions / agent-preset 的上游预发布兼容分派，避免把版本分支
  散进 bootstrap 与 channel 动作面。
  - 问卷 "provider 座位"守卫（DUPLICATE_PROVIDER 探测 + 私有 symbol 校验，#586）
    只在旧 rc 的 `registerProvider` 路径生效。
  - 0.1.2 线的 `user-questions/request` waterfall 对带 agent 的请求先按 scope
    过滤 listener；agentless 的 `/auth` 请求不带 scope carrier。
  - 按 answerer 约定，首个不调用 `next()` 委派的 eligible listener 会 claim 请求。
  - 但 Cordis waterfall 是 around middleware：外层 listener 即使调用 `next()`
    也能观察、替换或拒绝下游结果；`{ prepend: true }` 会把 listener 插到队首。
  - 上游没有受支持的方法发现或保留可验证的独占 claimant，
    因此 legacy seat guard 及其告警无法在本地复现。
- `src/dsh-adapter/channel.ts`：Channel 入口——后端中立核心
  `channel/core/`（绑定、输入管线、共享投影器的接线、宿主接缝、`/new`、本地动作、
  文件/报告、按能力委托的动作）+ 仅 DSH 会话挂载的扩展 `channel/extensions.ts`
  （rewind、resume、agent view、子代理/任务、模型/preset/模式、recap 等 DSH
  specialist 的接线）。会话事件由后端翻译器转成 `AgentEvent`，经唯一的共享投影器
  `src/channel/projection.ts` 成为 transcript 行。新增后端不写 channel 代码。
- `src/agent/`、`src/channel/`、`src/backends/claude/`、`src/backends/codex/`、`src/dsh-adapter/backend/`：
  后端中立的会话领域与共享投影器，以及各后端的翻译器与会话实现。结构、规则与接入
  新后端的步骤见 [多后端架构](agent-backend-design.md)。
- `src/screens/Chat.tsx`：顶层交互协调器。负责模态优先级、全局键盘、滚动/
  搜索/选区状态、slash 命令分发与聊天屏组装。
- `src/screens/StatusLine.tsx` 与 `src/screens/StatusMetrics.ts`：底部状态栏
  呈现与指标推导。
- `src/components/`：功能组件。`components/design-system/` 是主题感知原语；
  `components/messages/` 是 transcript 行；`components/questions/` 是
  `ask_user_question` 的 UI。
- `src/ui.ts`：本地渲染器、主题化 `Box`/`Text`、hooks 与公共 TUI 原语的
  首选门面。
- `src/ink/`：低层 Ink 系渲染器与终端实现。**敏感基础设施**：改动要聚焦，
  并附渲染器专用回归覆盖。
- `src/native-ts/yoga-layout/`：渲染器使用的移植布局引擎。
- `src/terminal-utils/`：终端格式化与呈现辅助。
- `src/*Prefs.ts`、`src/customTheme.ts`、`src/sessionHistory.ts`：持久化的
  用户偏好与 `~/.dsh-tui` 下的本地会话元数据。
- `.agents/skills/*/SKILL.md`：仅供仓库维护者使用的项目技能，由 DSH 文件系统
  provider 发现，不随 npm 包分发。
- `cordis.patch.yml`：profile 安装时使用的包级 bundle 覆盖层。行的顺序、行 ID、
  被禁用的 host 行、insert 与 override 的区分都很关键。
- `cordis.yml`：直接 Cordis/DSH 启动的完整裸组合示例。
- `scripts/`：无头回归、复现环境、探针与诊断。运行前先读脚本头部说明。
- `.github/scripts/pr-intake/`：PR 入口门禁（语言、关单文案、白名单、issue-link）。
  workflow 只编排；`pr-gate.yml` 必须 checkout 默认分支，不能跑 PR 头。
- `lib/`：由 `src/` 生成、忽略入库并随 npm 分发的 JavaScript、声明与声明映射。
  `./invariant` 也直接使用 `lib/types/dsh-adapter/invariant.js` 的编译结果。
- `README.md`（英文，默认门面）与 `README_ZH.md`（中文）：双语用户文档。
  行为、配置、快捷键与限制必须两版同步。

## 运行时形态（Runtime Shape）

核心运行时链路：

```text
Cordis config
  -> src/index.ts
  -> src/dsh-adapter/plugin.ts
  -> DSH agent/session services
  -> src/dsh-adapter/channel.ts（core + DSH extensions；AgentEvent -> 共享投影器 -> Channel snapshot）
  -> src/screens/Chat.tsx
  -> src/components/*
  -> src/ui.ts
  -> src/ink/* + Yoga layout
  -> terminal ANSI output
```

职责归属在各层，不要越权：

- Agent/会话/工具事实来自 DSH 服务与持久化会话事件。
- 投影属于共享投影器 `src/channel/projection.ts`，TUI 动作属于 channel 核心
  （`dsh-adapter/channel/core/`）与 DSH 扩展（`dsh-adapter/channel/extensions.ts`），
  不属于呈现组件。
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
  `vendor/dsh-std` 是 workspace 依赖，子模块为空时安装必失败。
- `pnpm-lock.yaml` 是唯一锁文件。npm 消费方不读依赖包的 lockfile，
  `package-lock.json` 已移除（见 #173 后续处理）。
- 有意改依赖时：用 `pnpm add` 更新 `pnpm-lock.yaml`，检查完整 lockfile diff，
  避免无关升级。
- 本包运行时或发布类型引用到的 `@deepseek-ai/*` 框架包（与
  `UPSTREAM_BLESSED_PACKAGES` 一一对应，含 `@deepseek-ai/schemastery`）必须同时
  是 peer 与 dev 依赖。
  - 框架包由宿主提供，profile 内运行时经 `$DSH_HOME/profiles/node_modules`
    回退树解析到宿主实例（见 #198——声明为 runtime dependency 会在 profile
    里落下真实拷贝，与宿主形成双模块实例）；dev 声明只为本地类型检查。
  - 新增此类引用时两组声明都要加、范围保持一致（verify:manifest-deps 门禁会校验）。
  - 仅测试/脚本使用的框架包（如 dsh-settings、dsh-tools、dsh-session-persistence-*）
    只需 dev 依赖，不要为它们声明 peer。
  - `dsh-working-activity` 等非宿主包仍是 runtime dependency。
  - 历史例外已消除：`dsh-working-activity@0.2.4` 及更早版本会经其 runtime
    dependency 把 `@deepseek-ai/schemastery`（连带 cosmokit）的真实拷贝带进
    profile；0.2.5 起已 peer 化（working-activity#2），profile 内不再有任何框架包拷贝。
  - 保持依赖范围不低于 `^0.2.6`（0.2.6 另修复 web 端 WorkingLine
    在未打补丁宿主上的空值守卫，working-activity#5）。
- 不要暴露、持久化或打印凭证。交互启动读取 `DEEPSEEK_API_KEY`；诊断可以
  报告是否已设置，但绝不能泄露完整值。

## 构建与生成产物（Build And Generated Files）

常规构建与类型检查关口：`pnpm build`。

- 该命令先删除整个 `lib/`，再用 `tsc -p tsconfig.json` 把 `src/` 输出到
  `lib/types/`，最后运行适配边界、上游契约与 patch surface 门禁。
- 编译前的 vendor 构建（`vendor/dsh-std`、`vendor/mathjax-tex-svg`）由
  `scripts/build-vendor.mjs` 负责：输入（子模块源码、锁文件、构建命令、Node
  版本）与产物文件逐字节都和上次成功构建一致时跳过，否则照常重建；
  `node scripts/build-vendor.mjs --force` 强制重建。指纹记在
  `node_modules/.cache/dsh-tui/vendor-build.json`。
- `verify:build` 按 CPU 数并行跑全部门禁，每个门禁独立临时 HOME，输出按门禁
  整块打印；`pnpm verify:build --jobs 1`（或 `DSH_TUI_VERIFY_JOBS=1`）恢复
  串行、实时输出，便于排查单个门禁。门禁不得依赖其他门禁留下的状态；确实需要
  独占机器的门禁登记进 `scripts/run-verify-build.mjs` 的 `SERIAL`，并写明原因。
- `prepare` 生命周期只服务**源码检出场景**的自举编译（vendor 子模块缺失时
  快速失败，见 scripts/prepare-guard.mjs）。
- Git URL 依赖安装自 vendoring（#308）起三重阻断（workspace 依赖/子模块/
  pnpm ≥11 prepare 白名单），不受支持，请装 registry 包。
- 本地与 CI 使用显式命令，不依赖 pnpm 是否隐式执行根包生命周期。

生成产物规则：

- 改 `src/`，**绝不直接改 `lib/`**。
- 任何源码改动后运行 `pnpm build`，但不要提交 `lib/` 下的生成结果。
- 干净编译会先删除整个 `lib/`，源模块重命名或删除后不会留下过期输出。
- 运行 `pnpm verify:package` 检查 `main`、`types`、`bin` 与 `exports` 的所有目标
  都进入 npm tarball，并 smoke-import 主入口和 invariant 入口。
- 纯文档、纯 workflow、纯 YAML 改动不需要重建（除非同时改了 TypeScript 输入）。
- 仅普通注释与空行的改动可免本地重建；行为、类型、配置或构建输入改动不适用。
  该豁免不免除下述按改动面必跑的回归；具体检查见“验证”。
- 使用 `--ignore-scripts` 安装 Git URL 会跳过 `prepare`，因而不受支持；registry
  包已经包含编译结果，不依赖消费者执行生命周期脚本。

`scripts/build.sh` 是面向本地 DeepSeek Harness 源码检出的备用构建器（定位 DSH
检出并重连依赖），不是本独立仓库的默认构建命令。

## 验证（Verification）

仓库没有根级 `test` 或 `lint` 脚本；不要声称跑过它们。TypeScript 构建是通用
静态关口，随后是聚焦的可执行回归。

本地验证按实际影响选择。

- 文档与 skill 改动：检查事实、链接、触发条件和指令冲突。
- 普通注释改动：检查说明与实现一致，并确认代码和类型未变（可用忽略
  注释的 AST 对比）。编译器指令、JSDoc 类型标注和构建工具注解不算普通注释。
- workflow 与 YAML 改动：检查语法和受影响的配置契约。
- 不为纯文字改写新增行为测试；所需检查通过后，仅因新改动、失败或未解决的
  风险扩大或重复验证。

CI 另按 `.github/workflows/ci.yml` 的 `changes` 路径白名单分流：`AGENTS.md`、
`.agents/skills/` 和源码中的注释不在文档豁免内，仍会触发代码门禁。本地无需
重建不代表 CI 会跳过；提交时保留所需门禁并如实说明本地验证范围。

`verify:build` 也检查源码输入卫生、渲染原语、终端尺寸来源（`ink/` 之外只经
`useTerminalSize()`）、主题与活动偏好迁移、状态动画、表格布局、mermaid 图表、
LaTeX 公式和侧问行为。源码卫生检查只拦截已列明的命名与编译产物回归，不替代
来源或许可证审计。

CI 的测试组按 `scripts/ci-group-timings.json` 的实测耗时分片（每条恰好落在
一片，表只影响均衡）；新增脚本不必改表，需要重新均衡时整组跑一次
`node scripts/run-ci-group.mjs <组> --record-timings`。

本地提速可加 `--jobs N`（缺省 1，与 CI 相同）：组内条目并发执行，每条仍有独立的
HOME 与渲染日志，输出按条整块打印。CI 环境下指定 `--jobs > 1` 会直接以退出码 2 拒绝运行。
并发下失败的条目会串行重跑一次：重跑通过
按 CPU 争用导致的偶发失败放行，但会以 `::error` 和汇总标记记下来；重跑仍失败才算
真失败。`--jobs > 1` 不能与 `--record-timings` 同用（并发下的耗时不准）。日常建议：
先跑改动区域的聚焦脚本（见下表），再对受影响的组加 `--jobs 4`，合并前跑
`pnpm build` 和四个测试组全量。

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

CI 的测试 job 设置 `DSH_TUI_LANG=zh` 作为兜底，但独立执行的回归不能依赖它；
本地跑尚未固定语言的脚本时，带上 `DSH_TUI_LANG=zh`，否则 lang.json 为 en 或
locale 为 `en_US` 的机器会误报失败。UI 语言在 import 时按 `DSH_TUI_LANG` →
`~/.dsh-tui/lang.json` → 系统 locale 解析。断言或定位界面文案的脚本（包括
「不出现某文案」的否定断言）必须自行固定与断言一致的语言：动态 import 前写
`process.env.DSH_TUI_LANG = 'zh'` / `'en'`；静态 import 的中文脚本把
`import './lib/default-lang-zh.mjs'` 放在其他 import 前。不要用 `??=` 保留宿主值，
也不要按宿主语言选择不同断言。已逐场景调用 `setLang` 的双语回归和仅用中文作
输入数据的宽度/剪贴板等测试不需要重复设置。
`node scripts/verify-regression-language.mjs`（先构建，已接入 `channel-ui` CI 组）
在临时 HOME 下覆盖与脚本预期语言相反的 locale、持久化偏好和环境变量三种启动条件，
同时保护中文正向断言和英文否定断言。`verify-ime-cursor`、`repro-suggestion-click`
和 `verify-queue` 的语言修复保留，但在既有固定等待迁移完成前仅独立运行，不进入 CI 矩阵。
诊断探针不作为此回归组全量执行；需要固定中文输出时显式带上 `DSH_TUI_LANG=zh`。

改动共享渲染、`Chat`、提示/问卷布局、工具卡、主题原语或 Ink core 时，三个
CI 回归都要跑。窄改动还要跑最近的聚焦脚本：

| 改动区域 | 聚焦验证 |
| --- | --- |
| 通用无头屏幕组装 | `pnpm smoke` |
| 跨代理会话迁移（src/migrate、adapter 解析或事件合成） | `node --import tsx/esm scripts/verify-migrate.mjs` |
| 共享投影器、DSH 翻译器 | `pnpm verify:projection-golden`、`node --import tsx/esm scripts/verify-dsh-translate.ts`、`pnpm verify:agent-domain` |
| Claude 后端 | 对应的 `scripts/verify-claude-*`（假 SDK，不花钱）与 `node --import tsx/esm scripts/verify-backend-channel.ts`；`verify:claude-live`/`verify:claude-headless` 调用真实 CLI，只在有意花费时手动跑（钉在 haiku） |
| 归档语义与后端 OAuth 登出 | `node --import tsx/esm scripts/verify-session-archive.tsx`（真实无头浏览器、假目录），`node --import tsx/esm scripts/verify-backend-logout.ts`（真实 channel/UI facade、假 OAuth host）；不触碰原生登录/真实凭据，DSH/Claude 默认删除语义保持 |
| Codex 原生后端 | `pnpm verify:codex-contract`、对应 `scripts/verify-codex-*` 的假 app-server/fixture 回归、`node --import tsx/esm scripts/verify-backend-channel.ts`；中立层改动再跑 DSH 黄金投影、Claude 对照与 `verify-agent-event-invariants.ts`。真实 `verify-codex-live.ts` / 探针只经 `codex-cheap-only.mjs` 守卫，真实 ChatGPT 登录/TTY 未跑须单列 |
| Channel submit/steer/pending 行为 | `node scripts/verify-submit.mjs` |
| 回退后编辑重发与历史 Inbox 清理 | `pnpm verify:rewind-edit` |
| 提示队列行为 | `node scripts/verify-queue.mjs` |
| Goal/todo 投影与渲染 | `node scripts/verify-channel-goal-todo.mjs` + `node scripts/verify-goal-todo.mjs` |
| Compaction 与折叠 transcript 行 | `node scripts/verify-compact.mjs` |
| 命令能力事实（compaction / plan / 问卷 / 剪枝的路由与 Help + `/` 的不可用标注） | `pnpm verify:agent-capabilities` |
| 压缩 × 会话切换生命周期（取消先于 fork 快照、persistence 分类提示） | `node --import tsx/esm scripts/verify-compact-switch.tsx` |
| 主题加载、持久化与运行时插件接缝 | `node --import tsx/esm scripts/verify-themes.mjs`、`node --import tsx/esm scripts/verify-runtime-themes.ts` |
| 默认推理强度等偏好链（effortPrefs / settings 默认值） | `node --import tsx/esm scripts/verify-effort-default.ts` |
| 滚动/粘底行为 | `node scripts/verify-scroll.mjs`、`node scripts/verify-resticky.mjs`、`node --import tsx/esm scripts/verify-post-shrink-anchor.tsx` 及对应 `repro-*` 环境 |
| 计划评审长正文（`exit_plan_mode` 窗口化 + 滚轮） | `node --import tsx/esm scripts/verify-plan-review-scroll.tsx` |
| 全屏复制即选区 | `node scripts/verify-copy-on-select.mjs` |
| 组件级鼠标拖拽协议（目标捕获、事件冒泡、点击/选区兼容与中断收尾） | `node --import tsx/esm scripts/verify-drag-protocol.tsx` |
| 鼠标指针事件管线（滚轮坐标/修饰位、点击/hover 派发、越界 clamp、指针态重置） | `node --import tsx/esm scripts/verify-pointer-events.ts` |
| Hover 事件性能（兴趣边界完整、无兴趣矩形快路径、帧边界/多 root 失效） | `node --import tsx/esm scripts/verify-hover-coalesce.tsx` |
| 输入框鼠标选区编辑（拖选/Shift+click/双击选词/删除替换/Esc 分层/Ctrl+C 复制、CJK 宽字符与 fold 侧钳制） | `node --import tsx/esm scripts/verify-input-selection.tsx` |
| Sixel 编码、worker 缓存、缩略图/预览生命周期 | `node --import tsx/esm scripts/verify-terminal-images-sixel.tsx`、`node --import tsx/esm scripts/verify-sixel-transcript.tsx`；耗时对比 `node --import tsx/esm scripts/bench-sixel-encode.tsx` |
| Markdown 独立节点（表格、mermaid 图、公式块）、LaTeX 公式与流式分块间距 | `pnpm verify:table-layout`、`pnpm verify:mermaid-diagram`、`pnpm verify:latex-math`、`node --import tsx/esm scripts/verify-streaming-markdown-spacing.tsx` |
| 跨进程会话占用账本（失败行为、严格读、锁回收、预约） | `pnpm verify:session-mounts` |
| 未发送草稿的跨屏交接（快照、光标、图片绑定、归属） | `pnpm verify:composer-draft-handoff`；端到端换屏另见 `node scripts/verify-session-browser.mjs` |

多数用普通 `node` 调用的脚本 import `lib/types/`——先跑 `pnpm build`。import
TypeScript 源的脚本在头部声明 `node --import tsx/esm <script>` 形式。不要凭
扩展名推断输入层：例如 `verify-themes.mjs` 其实通过 tsx import `src/`。

写回归脚本时，等待原语用 `scripts/lib/term-test.mjs`：「等待后断言」用
`settled`，「等待后操作」用 `settle`。

- 保留的固定 `sleep(` 必须带机读标签 `固定窗:探针` / `固定窗:墙钟` /
  `固定窗:pacing`（定义见该文件头部），写在 sleep 同行尾注释或紧贴上方注释里。
- `verify:fixed-window` 门禁扫描 `scripts/run-ci-group.mjs` 与
  `scripts/verify-regression-language.mjs` 登记的脚本（含矩阵子进程），无标签即失败。
- `固定窗:待迁移` 是存量技术债（清零跟踪 #791），按文件计数锁在
  `scripts/fixed-window.baseline.json`：任一文件增加即失败，旧债减少不能抵消。
- 清掉一处后用 `--write-baseline` 重写基线并一起提交。新代码不得使用。

部分脚本是取证/交互工具而非有界测试：堆/泄漏脚本、PTY 探针、回放捕获、
性能探针与 `scripts/run.ts` 可能依赖特定 OS、终端、原生依赖、DSH 检出或长时
进程。读头部与前置条件，不要把 `scripts/` 当套件全跑。

终端可见改动：无头断言必要但不充分。

- 环境可用时，在 inline 与 fullscreen 两种模式、窄终端宽度下手动走一遍
  受影响流程：启动、resize、滚动、输入、取消与干净退出。
- Windows ConPTY、tmux、OSC 剪贴板与同步输出有独立路径，改动它们时用对应探针。

`pnpm tui` 调用 `scripts/run.ts`，它假定包位于 DeepSeek Harness monorepo
（`apps/cli` + `packages/*`）布局内，不是可移植的独立冒烟命令。端到端集成检查：
把插件装进 DSH profile，在真实 TTY 用所需凭证运行 `dsh --profile dsh-tui`。

## TypeScript 与风格（TypeScript And Style）

- 包是 ESM。TypeScript 相对导入用 `.js` 后缀（如
  `import { Chat } from './screens/Chat.js'`）。保持此规则。
- 仓库自写 TypeScript 遵循现有风格：两空格缩进、单引号、无分号、多行结构
  尾逗号。Ink 系渲染器文件（`src/ink`）可保留上游的 tab 或引号风格，不要批量格式化。
- 纯类型依赖优先 `import type`。
- 不要因为 `tsconfig.json` 放宽了 `noImplicitAny` 就引入 `any`。那些放宽是
  为了编译 Ink 系渲染器，不能成为新应用代码的质量基准。用 `unknown` 并收窄，
  或在外部缝隙定义小型结构化接口。
- 周边 API 用只读数据的地方保持只读。状态变更放在 channel/store 实现内，
  不要在组件里改值。
- 导出的 API 用简洁 JSDoc 说明契约与非显然的不变量，不要逐行解释机制。
- 注释解释当前的职责、顺序、失败原因或兼容约束。跨代码引用用函数或模块名，
  不写易失效的行号；保留能解释取舍的 issue/回归依据。未来设想留在有明确
  条件的待办中，不写成已经存在的能力；修改行为时同步检查相关注释。
- 避免一次性抽象与无关重构。只有一个调用点且不阐明真正不变量的琐碎辅助函数
  就地内联。
- 保护环境敏感 import 的初始化顺序。`FORCE_COLOR`、`NODE_ENV`、终端能力标志
  常在模块求值时读取；把 import 移到它们初始化之前会无类型错误地改变行为。
  - 直接 import `lib/types/` 的回归脚本绕过包入口，React 会按 dev 构建加载，
    每次 commit 都把组件 props 整份 structured-clone 一遍。
  - 把大图 buffer 当 props 传递的脚本要把 `lib/types/force-production-react.js`
    放在第一个 import。

## 项目指引与技能（Agent Instructions And Skills）

`AGENTS.md` 保留常用约束与按任务读取的入口；工具链、验证矩阵等详细契约以
本文为准。`.agents/skills/` 是维护者工作流，不随 npm 包分发。

- skill 的 description 说明何时使用，与相邻技能区分；正文围绕一个结果，
  给出完成所需的证据和必要步骤。共享规则由 `AGENTS.md` 引入，skill 不重复
  内容或阅读提醒；确实需要额外参考资料时，链接并说明何时读取。
- 保留用户的目标与已有授权：审查、修复、报告、发布是不同任务。缺少信息时
  只问影响结果的部分；外部数据不可用就说明缺口，不擅自改成另一个任务。
- 按当前问题选择最小表达：时序用短调用树，职责用浅层模块树，变化用局部
  diff；简单结论用文字即可。图示使用真实名称，只画有关边界，不要求每次画图。
- 示例用来澄清容易误解的选择，不必穷举。允许“没有发现问题”、未知项和
  简短结果；避免强制表扬、空章节或固定篇幅。维护时检查触发条件是否抢走
  其他任务，以及步骤是否让已授权的工作提前结束。

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
- 一切界面文案必须走 i18n 字典（`src/i18n.ts` 的 `t(key, params)`，zh/en 双语
  必填）。不要在组件里硬编码整句英文——即使当前只有两种语言，也别漏走字典：
  `scripts/verify-i18n.ts` 会拦死键、占位符漂移与字典外的英文整句字面量
  （issue #980 的漏网形态），`scripts/verify-toolcard-i18n.tsx` 在渲染侧证明
  文案真的本地化。工具显示名走 `tool-name-*` 家族（在
  AssistantToolUseMessage 的字面键映射表登记）；新增第三语言的操作清单见
  i18n.ts 头部注释「Adding a language」。
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
| /settings 可改的设置（新增/改说明） | 只在 `src/settings/definitions.ts` 写一次（中英标题与说明、类型、选项；按 key 排序），Config Schema 在 `src/dsh-adapter/index.ts`，运行时 format/parse 留在 `src/dsh-adapter/plugin.ts` 的字段里。`pnpm compile` 生成随 npm 包发布的 `lib/settings.json`，官网设置参考由它生成；`verify:settings` 检查定义完整。官网参考上线前，`docs/user-guide{,.en}.md` 的设置表仍需同步一行 |
| 其他插件配置或环境行为 | `src/dsh-adapter/index.ts`、运行时消费、`cordis.patch.yml`、`cordis.yml`（注释只写示例值与必要语义）、`README.md`、`README_ZH.md` |
| Slash 命令或快捷键 | `src/commands.ts`、`src/screens/Chat.tsx`、帮助/输入组件、双 README、相关技能映射/测试 |
| 主题契约、插件接缝或持久化主题行为 | `src/theme.ts`、`src/themeCatalog.ts`、`src/dsh-adapter/themes.ts`、所有色板、主题 provider/picker、自定义主题解析器、主题验证、双 README、插件文档 |
| 会话/channel 行为 | 后端中立的放 `src/dsh-adapter/channel/core/`，DSH 专属的放 `channel/extensions.ts` 及其 specialist、受影响的 UI 投影、编译产物、聚焦 channel/回放回归（含 `verify-backend-channel`、`verify-channel-rollback`） |
| 渲染器/布局行为 | `src/ink/` 或 Yoga 源、编译产物、CI 回归、聚焦滚动/resize/PTY 探针 |
| 技能发现或呈现 | DSH adapter、slash 命令合并、`/skills` 与相关回归；项目维护技能放 `.agents/skills/` 且不得加入 npm 包 |
| 用户可见的文档化行为 | 中英文 README，适用的配置注释/帮助文本与 `docs/` 双语页；新增用户手册同时改 `scripts/guide-sources.mjs` 清单、`guide/dsh-tui-guide/SKILL.md` 路由，再 `node scripts/build-guide.mjs` / `node scripts/verify-guide.mjs`（不手改副本） |
| 贡献入口或 PR 门禁 | `.mergify.yml`、`docs/contributing.md`、`docs/contributing.en.md`、`.github/workflows/pr-gate.yml`、`.github/scripts/pr-intake/`、`.github/APPROVED_CONTRIBUTORS` |
| 包版本或依赖 | `package.json`、`pnpm-lock.yaml`、适用时的生成/发布产物；不要顺手搅动旧 npm 锁文件 |
| 新增或改动后端 | 新建 `src/backends/<id>/`（`manifest.ts` + 实现），并提交 `pnpm compile` 重新生成的 `src/dsh-adapter/backends.generated.ts`（入库的生成产物，过期会被 `verify-backend-registry` 判红）：构建期索引由 `scripts/gen-backend-index.mjs` 生成，**不要**手改 `src/kernelPrefs.ts`、`src/dsh-adapter/backends.ts`（目录与身份断言都按 ID 取项，新增目录不必同步任何回归）；边界门禁的厂商包/`native.<id>` 规则由 manifest 派生，但派生结果与 `scripts/verify-adapter-boundary.ts` 的 `EXPECTED_*` 快照**逐字比对**——声明了非空 `vendorPackages` 或 `nativeKey` 的后端必须把该快照与 `ADAPTER.md` 一并更新（门禁报错会写明），只声明 `vendorPackages: []`、不声明 `nativeKey` 的后端无需改动；`install` 是声明式配方（`{ executor, specifier, version }`），宿主侧执行器表在 `src/dsh-adapter/install/`（首版只有 `pnpm-profile-add`）：注册表查表派生"这个条目可不可装"，装的是你声明的 specifier，声明了宿主不认识的执行器只等于"没有安装面"（不抛错）；没有包可装的后端（驱动系统 CLI 的那类）就不声明；名字走 manifest（插件用 `kind:'literal'`，绝不进 i18n 字典）；模块级/进程级资源池声明 `unloadExport`，会话级资源仍归 `session.dispose()`；`id`、`label` 与 `install` 的边界见 `ADAPTER.md` 的「后端 manifest」；新增后端要把聚焦回归登记进 `scripts/run-ci-group.mjs`，注册表门禁是 `scripts/verify-backend-registry.ts`；用户可见取值（`--backend`、配置行）同步双 README 与 `docs/configuration{,.en}.md` |
| Claude Agent SDK 版本 | `package.json` 的 optional peer 与 dev 两处精确版本、`pnpm-lock.yaml`、`src/backends/claude/contract.ts`（`VALIDATED_SDK_VERSION`/`VALIDATED_CLI_VERSIONS`）、`docs/claude-backend{,.en}.md` 的安装命令；`verify:claude-contract` 检查一致 |
| Codex 协议/验证版本 | 用 `scripts/codex-protocol-sync.mjs` 正规生成类型、更新 `src/backends/codex/contract.ts`、方法表/fixture/脱敏与 live/replay 回归、双语 Codex 用户说明；不添加 Codex SDK npm 依赖，不拿最低版本当全部实验接口已验证 |
| 上游验证线 bump | `src/dsh-adapter/contract.ts`、`src/dsh-adapter/oauth/`、`package.json` peer+dev 两组范围、`pnpm-workspace.yaml`、`.github/workflows/ci.yml` alpha-compat 的上游 SHA、`scripts/verify-{alpha-source,patch-surface,web-coexistence,upstream-contract}` 内的版本常量、`patch-surface.snapshot.json`、`ADAPTER.md`、`docs/user-guide.md`；步骤见 [ADAPTER.md](../ADAPTER.md) 升级流程 |

## Git 与发布安全（Git And Release Safety）

- 工作树可能含有他人的改动。编辑前检查 `git status` 与相关 diff，保留无关
  改动，绝不丢弃不是你创建的工作。
- 不要运行破坏性清理命令（`git reset --hard`、`git checkout .`、
  `git clean -fd`）。不要用 `git stash` 隐藏他人会话的工作。
- 只暂存显式路径，绝不在共享工作树用 `git add .` 或 `git add -A`。
- commit、tag、push、发布与 Release 需要用户授权；本次会话中已给出的授权
  继续有效，无需在每个步骤重复确认。授权某一操作不自动扩展到其他发布操作。
- 发布由 tag 驱动：`.github/workflows/publish.yml` 要求 `v*` tag 与
  `package.json` 版本完全一致，随后构建、跑聚焦回归并发布 npm。版本变更与
  tag 是发布操作，不是日常清理。
- Release note 带贡献者署名，GitHub Release 不手建：`publish.yml` 发布 npm 后
  自动创建该 tag 的 Release，正文用 GitHub Release Notes API 生成 What's Changed
  （PR 标题 + 作者 + 链接）、New Contributors 与 Full Changelog；
  `.github/release.yml` 从自动清单里排除 bot。Release 缺 `SHA256SUMS` 所列任一资产时，
  同一 run 构建并上传整合包（重跑也会补齐）。
  - 可选手写摘要：打 tag 前提交 `.github/release-notes/vX.Y.Z.md`，自动清单接在它后面；
    没有该文件就只有自动清单。
  - 自动清单前有 `<!-- dsh-tui:generated-notes -->` 标记。Release 已存在（重跑、或维护者
    先手建）时只更新不失败：有该标记或 `## What's Changed` 就不动；否则把自动清单追加
    在原正文后面，绝不覆盖。
  - 补发已有 tag 的 Release note：Actions → Publish → Run workflow → 填 tag，
    只处理正文，不发布 npm、不构建整合包。
  - 手写摘要中每条都在末尾标 `（#PR号 by @用户名）`，维护者与外部
    贡献者一视同仁；裸写 `#123` 与 `@user`，GitHub 渲染成链接。
- 移交代码改动前检查 `git diff --check`、源码 diff、生成 diff 与 `git status`，
  并如实报告跑了哪些验证、哪些平台/凭证相关的检查没跑。
