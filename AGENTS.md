# AGENTS.md

dsh-TUI 是 DeepSeek Harness 的终端界面插件：零核心改动、纯插件挂载的 Claude Code 风格 TUI（`@deepseek-harness-tui/dsh-tui`）。Agent、会话、模型、工具、持久化与策略域由 DeepSeek Harness 拥有，本包只消费它们。改动前先读 [docs/contributing.md](docs/contributing.md)（本仓库共享开发契约的权威文本）与 [ADAPTER.md](ADAPTER.md)（上游边界与契约）；整体结构见 [docs/architecture.md](docs/architecture.md)。

## 仓库布局

```
src/index.ts        公共 Cordis 插件入口、配置 Schema、对运行时实现的惰性移交
src/plugin.ts       运行时实现：TTY 校验、服务注册、Agent 创建/恢复、React 树挂载与收尾
src/channel.ts      会话事件 → 视图投影 + 非 React 动作面（submit/steer/rewind/resume/切换）
src/screens/        Chat.tsx 交互协调器与状态栏呈现
src/components/     功能组件；design-system/ 是主题感知原语
src/ui.ts           本地渲染器、主题化 Box/Text 与公共 TUI 原语的首选门面
src/ink/            移植的 Ink 渲染器与终端实现——敏感基础设施，改动聚焦并附专用回归
src/native-ts/      渲染器使用的移植 Yoga 布局引擎
src/cc/             Claude Code 风格的终端格式化与呈现辅助
src/dsh-adapter/    唯一允许 import 官方 @deepseek-ai/* 的位置
src/*Prefs.ts 等    ~/.dsh-tui 下的持久化用户偏好与会话元数据
skills/             随 npm 包分发的技能（src/packaged-skills.ts 注册）
presets/            随包分发的 preset（liangshen）
bin/dsh-tui.js      dsh-tui 直达命令入口
vendor/dsh-std      vendored 依赖（frozen lockfile 构建，见 scripts/build 相关脚本）
dsh-ecosystem-spec/ 生态适配规范子项目（自带 CONTRIBUTING 与治理文档）
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
pnpm compile                    # 干净编译 src/ → lib/types/（先删整个 lib/）
pnpm build                      # compile + 全部构建门禁
pnpm verify:build               # 构建门禁（边界/契约/patch surface/plugin 系列等），不重复编译
pnpm verify:package             # npm tarball 目标完整 + 入口 smoke import
pnpm smoke                      # 通用无头屏幕组装冒烟
```

仓库**没有根级 `test` 或 `lint` 脚本**——不要声称跑过它们。静态关口是 TypeScript 构建；行为验证靠聚焦回归脚本与复现环境。多数用普通 `node` 调用的脚本 import `lib/types/`，先 `pnpm build`；import TypeScript 源的脚本在头部声明 `node --import tsx/esm <script>`。不要凭扩展名推断输入层（`verify-themes.mjs` 实际经 tsx import `src/`）。`scripts/` 还含取证/交互工具（堆分析、PTY 探针、回放捕获、性能探针），不是有界测试，不要当套件全跑。

- 按改动面选验证：共享渲染、`Chat`、提示/问卷布局、工具卡、主题原语或 `ink/` core 的改动必须跑 CI 回归；窄改动跑对应聚焦脚本，对照表见 [docs/contributing.md](docs/contributing.md)。终端可见改动在无头断言之外，环境可用时在 inline 与 fullscreen 两种模式、窄终端宽度下手动演练受影响流程。
- 纯文档、纯 workflow、纯 YAML 改动不需要重建（除非同时改了 TypeScript 输入）。

## 上游边界与契约

- 官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内 import；UI 层（`screens/`、`components/`、`ink/`、`hooks/`、`utils/`、`cc/`）一律通过 adapter facade 间接接触上游。`pnpm run verify:boundary` 扫描全部源码，发现越界即失败。
- 校验版本线、peer 范围与 blessed 包清单在 `src/dsh-adapter/contract.ts`；本地检测到 drift 打警告，CI 上 `verify:contract` 直接失败。
- 运行时或发布类型引用的 `@deepseek-ai/*` 框架包必须同时是 peer 与 dev 依赖（`verify:manifest-deps` 门禁）；仅测试/脚本使用的框架包只进 dev 依赖。
- `cordis.patch.yml` 对官方行的干预已快照到 `patch-surface.snapshot.json`，改动需保持同步（`verify:patch-surface` 门禁）。

## 约定与红线

- **源码与产物分离**：改 `src/`，绝不直接改 `lib/`，不提交 `lib/` 下的生成结果。
- **真源投影**：持久化的 DSH 会话事件日志是 transcript 真源；不要插入可能与持久化分歧的乐观助手/工具事实。保留事件顺序、序列锚点与 call-ID 匹配。
- **职责分层**：投影与 TUI 动作属于 `channel.ts`，交互模式与按键优先级属于 `Chat.tsx`，终端协议、布局与帧差分属于 `ink/`。不要为界面好写而在 TUI 里重实现 DSH 域服务——经 channel 或既有注册表缝隙适配。
- **注册即效应**：资源经 Cordis 注册，用 `ctx.effect` 或既有单一退出漏斗清理。渲染失败必须响亮且非零退出；正常退出前恢复终端状态（raw 模式、光标、alt-screen、同步输出、鼠标、焦点）。
- **渲染安静**：TUI 活动期间不加 `console.log` 或 stdout 诊断；用 opt-in 的 stderr/调试路径（`DSH_TUI_DEBUG`、`DSH_TUI_RENDER_LOG`）。
- **TypeScript**：纯 ESM，相对导入用 `.js` 后缀；纯类型依赖优先 `import type`；不因移植 Ink core 的放宽而引入 `any`，用 `unknown` 收窄；遵循现有两空格、单引号、无分号风格，不批量格式化移植文件。
- **终端宽度是显示单元宽度**，不是 JS 字符串长度；考虑 ANSI 转义、组合字符、emoji 与东亚宽字符，用仓库的宽度/切片/换行辅助函数。
- **双语文档同步**：行为、配置、快捷键与限制在 `README.md` 与 `README_EN.md` 两版同步。插件配置、slash 命令、主题、渲染器、打包技能的跨文件同步清单见 [docs/contributing.md](docs/contributing.md)。
- **密钥**：交互启动读取 `DEEPSEEK_API_KEY`；诊断只能报告是否已设置，绝不泄露完整值。
- **Git 安全**：只暂存显式路径，不用 `git add .`/`git add -A`；不运行破坏性清理命令；未经要求不 commit、不打 tag、不 push、不发布。发布由 `v*` tag 驱动且必须与 `package.json` 版本完全一致。

## 编辑本文件

`CLAUDE.md` 是指向 `AGENTS.md` 的符号链接；编辑真身。每条规则保持自包含，细节链接到权威文档；表达在清晰存活时优先精简。
