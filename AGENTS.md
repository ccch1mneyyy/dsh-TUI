# AGENTS.md

dsh-TUI 是 DeepSeek Harness 的终端界面应用（`@deepseek-harness-tui/dsh-tui`），零核心改动、只消费 DSH 的公开导出。DSH 是首要适配目标与首方后端；本包正从「DSH 的插件」演进为「拥有自身入口与组装根的终端应用」，届时 DSH 与 claude / codex 一样作为后端按需在进程内加载。Agent、会话、模型、工具、持久化与策略域仍然由 DeepSeek Harness 拥有，本包只消费它们。改动前先读 [docs/contributing.md](docs/contributing.md)（本仓库共享开发契约的权威文本）与 [ADAPTER.md](ADAPTER.md)（上游边界与契约）；整体结构见 [docs/architecture.md](docs/architecture.md)；独立宿主的方案与非目标见 [docs/standalone-host-design.md](docs/standalone-host-design.md)。

## 仓库布局

```
src/index.ts        公共 Cordis 插件入口、配置 Schema、对运行时实现的惰性移交
src/dsh-adapter/plugin.ts  运行时实现：TTY 校验、服务注册、Agent 创建/恢复、React 树挂载与收尾
src/dsh-adapter/host-entry.ts  本包入口：非 DSH 内核不组合完整 DSH profile（改组合轻量 profile：本包的行 + profile 声明的第三方插件）、在裸 Cordis 根上挂运行时；路由判定在 src/hostEntryRoute.ts（docs/standalone-host-design.md）
src/dsh-adapter/channel.ts  Channel 入口：后端中立核心（channel/core/）+ 仅 DSH 会话挂载的扩展（channel/extensions.ts）
src/agent/          后端中立的会话领域：AgentEvent、AgentSession、类型化能力（无 I/O、无厂商依赖）
src/channel/        共享投影器（AgentEvent → 视图状态）与审批/问卷等中立 store
src/backends/claude/  实验性 Claude Agent SDK 后端；多后端结构见 docs/agent-backend-design.md
src/backends/codex/  Codex app-server 原生后端：协议、hub、翻译器与能力；不捆绑 Codex npm 依赖
src/dsh-adapter/oauth/    内置订阅 OAuth：provider 路由、/auth、凭据存储与问卷桥接
src/screens/        Chat.tsx 交互协调器与状态栏呈现
src/components/     功能组件；design-system/ 是主题感知原语
src/components/sidePanel/  侧栏分栏（几何、标签栏、PanelHost、键盘接缝）与内置面板适配
src/themeCatalog.ts  内置、静态 JSON 与运行时插件主题的统一列表/解析
src/ui.ts           本地渲染器、主题化 Box/Text 与公共 TUI 原语的首选门面
src/ink/            Ink 系渲染器与终端实现——敏感基础设施，改动聚焦并附专用回归
src/native-ts/      渲染器使用的 Yoga 布局引擎
src/terminal-utils/ 终端格式化与呈现辅助
src/dsh-adapter/    唯一允许 import 官方 @deepseek-ai/* 的位置；themes.ts 提供 tuiThemes 插件接缝
src/*Prefs.ts 等    ~/.dsh-tui 下的持久化用户偏好与会话元数据；src/tuiSettingsFile.ts 是 /settings 的 dsh-tui 分区（settings.json）
.agents/skills/     仅供仓库维护者使用的项目技能，不随 npm 包分发
presets/            随包分发的 preset（liangshen）
bin/dsh-tui.js      dsh-tui 直达命令入口
vendor/dsh-std      vendored 依赖（frozen lockfile 构建，见 scripts/build 相关脚本）
tui-profile/        仓内 TUI Profile：插件准入 + 私有协议定义（纯文件，随本仓代码修订）
cordis.patch.yml    profile 安装的包级覆盖层；行序、行 ID 与 insert/override 语义关键
cordis.yml          直接 Cordis/DSH 启动的完整裸组合示例
scripts/            无头回归、复现环境、探针与诊断；运行前先读脚本头部说明
docs/               根 README 之外的完整文档；中文无后缀，英文 .en.md 后缀
lib/                由 src/ 生成的产物——忽略入库、随 npm 分发，绝不手改
```

完整仓库地图与运行时链路见 [docs/contributing.md](docs/contributing.md)。

## 命令

```sh
pnpm install --frozen-lockfile  # pnpm 11；Node ^22.19 || >=24（CI 用 Node 24）
pnpm compile                    # 干净编译 src/ → lib/types/（先删整个 lib/；vendor 构建未变则跳过）
pnpm build                      # compile + 全部构建门禁
pnpm verify:build               # 构建门禁（边界/契约/patch surface/plugin 系列等），并行、不重复编译；--jobs 1 串行排查
pnpm verify:package             # npm tarball 目标完整 + 入口 smoke import
pnpm smoke                      # 通用无头屏幕组装冒烟
```

仓库**没有根级 `test` 或 `lint` 脚本**——不要声称跑过它们。静态关口是 TypeScript 构建；行为验证靠聚焦回归脚本与复现环境。多数用普通 `node` 调用的脚本 import `lib/types/`，先 `pnpm build`；import TypeScript 源的脚本在头部声明 `node --import tsx/esm <script>`。不要凭扩展名推断输入层（`verify-themes.mjs` 实际经 tsx import `src/`）。`scripts/` 还含取证/交互工具（堆分析、PTY 探针、回放捕获、性能探针），不是有界测试，不要当套件全跑。

- 按改动面选验证：共享渲染、`Chat`、提示/问卷布局、工具卡、主题原语或 `ink/` core 的改动必须跑 CI 回归；窄改动跑对应聚焦脚本，对照表见 [docs/contributing.md](docs/contributing.md)。终端可见改动在无头断言之外，环境可用时在 inline 与 fullscreen 两种模式、窄终端宽度下手动演练受影响流程。
- 纯文档、纯 workflow、纯 YAML 改动不需要重建（除非同时改了 TypeScript 输入）。

## 上游边界与契约

- 厂商包按目录隔离：`@deepseek-ai/*` 只在 `src/dsh-adapter/`，`@anthropic-ai/*` 只在 `src/backends/claude/`；后端中立层 `src/agent/`、`src/channel/` 不 import 厂商包、`src/dsh-adapter/` 与 `src/backends/`；UI 层不 import `src/backends/`，从 `src/dsh-adapter/` 只取类型（存量值 import 的 allowlist 只减不增）。完整规则表见 [ADAPTER.md](ADAPTER.md)；`pnpm run verify:boundary` 扫描全部源码，越界即失败。
- 校验版本线、peer 范围与 blessed 包清单在 `src/dsh-adapter/contract.ts`；本地检测到 drift 打警告，CI 上 `verify:contract` 直接失败。
- 本包入口按宿主 realpath 加载已装 `dsh` 的模块：清单、复刻面与偏差的唯一来源是 `src/dsh-adapter/host-contract.ts`，加载只在 `host-dsh.ts`（对 `@deepseek-ai/*` 只 `import type`）；`verify:contract` 跑假宿主回退，有已装宿主时再跑能力探测与复刻指纹（`host-replica.snapshot.json`）；宿主 CLI 不是依赖，版本线移动时在装有该版本 `dsh` 的机器上复核。见 [ADAPTER.md](ADAPTER.md)「独立入口的宿主契约」。
- 运行时或发布类型引用的 `@deepseek-ai/*` 框架包必须同时是 peer 与 dev 依赖（`verify:manifest-deps` 门禁）；仅测试/脚本使用的框架包只进 dev 依赖。
- `cordis.patch.yml` 对官方行的干预已快照到 `patch-surface.snapshot.json`，改动需保持同步（`verify:patch-surface` 门禁）。

## 约定与红线

- **源码与产物分离**：改 `src/`，绝不直接改 `lib/`，不提交 `lib/` 下的生成结果。
- **真源投影**：后端的持久化会话记录（DSH 会话事件日志、Claude 的转录文件）是 transcript 真源；不要插入可能与持久化分歧的乐观助手/工具事实。保留事件顺序、序列锚点与 call-ID 匹配。
- **职责分层**：投影属于共享投影器 `src/channel/projection.ts`，TUI 动作属于 channel 核心 `dsh-adapter/channel/core/` 与 DSH 扩展 `channel/extensions.ts`（新后端经会话能力接入，不写 channel 代码），交互模式与按键优先级属于 `Chat.tsx`，终端协议、布局与帧差分属于 `ink/`。不要为界面好写而在 TUI 里重实现 DSH 域服务——经 channel 或既有注册表缝隙适配。
- **注册即效应**：资源经 Cordis 注册，用 `ctx.effect` 或既有单一退出漏斗清理。渲染失败必须响亮且非零退出；正常退出前恢复终端状态（raw 模式、光标、alt-screen、同步输出、鼠标、焦点）。
- **渲染安静**：TUI 活动期间不加 `console.log` 或 stdout 诊断；用 opt-in 的 stderr/调试路径（`DSH_TUI_DEBUG`、`DSH_TUI_RENDER_LOG`）。
- **TypeScript**：纯 ESM，相对导入用 `.js` 后缀；纯类型依赖优先 `import type`；不因 Ink 系渲染器的放宽而引入 `any`，用 `unknown` 收窄；遵循现有两空格、单引号、无分号风格，不批量格式化渲染器文件。
- **终端宽度是显示单元宽度**，不是 JS 字符串长度；考虑 ANSI 转义、组合字符、emoji 与东亚宽字符，用仓库的宽度/切片/换行辅助函数。
- **尺寸只有一个来源**：`ink/` 之外一律经 `useTerminalSize()` 取尺寸（页边距、分栏会逐层收窄它），不直接读 `stdout.columns/rows` 或自行监听 resize；确需物理终端的，登记进 `verify:terminal-size-source` 的 `ALLOWED` 并写明理由。
- **双语文档同步**：行为、配置、快捷键与限制在 `README.md`（英文默认）与 `README_ZH.md`（中文）两版同步。插件配置、slash 命令、主题、渲染器、技能发现的跨文件同步清单见 [docs/contributing.md](docs/contributing.md)。
- **密钥**：交互启动读取 `DEEPSEEK_API_KEY`；诊断只能报告是否已设置，绝不泄露完整值。
- **PR**：创建或更新 PR（包括改写描述）一律使用 `.agents/skills/pr`。
- **Git 安全**：只暂存显式路径，不用 `git add .`/`git add -A`；不运行破坏性清理命令；未经要求不 commit、不打 tag、不 push、不发布。发布由 `v*` tag 驱动且必须与 `package.json` 版本完全一致。

## 代码审查原则

审查 PR 时，以**不引入新 Bug、最小必要改动、保持代码简洁**为核心原则：

1. **防止回归**：优先检查新增 Bug、竞态、资源泄漏、性能退化及兼容性问题，特别关注共享代码（`src/agent/`、`src/channel/` 等后端中立层）对其他后端和既有功能的影响。
2. **避免过度设计**：识别重复实现、无必要的抽象、冗余封装及过度防御性编程。只有存在更简单的等效方案时才报告，不误判必要的安全校验和错误处理。
3. **严格控制范围**：改动应围绕 PR 目标及关联 Issue，不夹带无关重构、格式化、依赖升级或其他功能修改。必要的测试和文档同步除外。
4. **保证实质价值**：关注无效代码、重复逻辑、无意义的文件拆分和缺乏有效断言的测试。不以代码行数或提交次数判断贡献价值，不推测贡献者动机。
5. **审查必须有据**：只报告本次 PR 引入的实质问题，说明具体位置、触发条件和实际影响，优先给出最小修复建议。不为凑评论而挑刺。

## 编辑本文件

`CLAUDE.md` 是指向 `AGENTS.md` 的符号链接；编辑真身。每条规则保持自包含，细节链接到权威文档；表达在清晰存活时优先精简。
