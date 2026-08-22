# pi-tui 渲染管线迁移实施计划

## 0. 目标和范围

当前版本为 `0.8.7`，目标是一次性完成 `0.9.0` 的 pi-tui 渲染迁移。本计划只覆盖让新渲染链可启动、接收输入、更新内容并可靠退出所需的工作；不把旧 UI 的全部视觉行为重新建成一套治理项目，也不以中间兼容版本为目标。

执行顺序固定为 `WP-00` 到 `WP-05`。迁移期间不保留 React fallback、第二 renderer、第二 TUI 或第二 stdout owner。

整体方案唯一确定为 Kimi 方式（参考 `/home/sisct/Code/oss/kimi-code` 的实际做法）：`packages/pi-tui/` 是上游 pi-tui 的 vendored fork，生产直接使用 fork 自带的原生 `ProcessTerminal` 作为唯一 stdin/stdout owner；dsh 侧只做 facade、bootstrap 和生命周期组合封装，不做 terminal-session 注入，也没有 dsh `TerminalWriter`。

## 1. 不可变架构决策

### 1.1 唯一生产链

生产入口和目标链如下：

```text
src/index.ts
  -> src/dsh-adapter/index.ts
  -> src/dsh-adapter/plugin.ts
  -> src/tui/bootstrap.ts
  -> 唯一 TUI（经 src/tui/public.ts facade 从 fork 包导入）
  -> 唯一原生 ProcessTerminal（唯一 stdin/stdout owner）
  -> TuiMainScreen（inline）或 TuiAltScreen（fullscreen）
  -> stdout

src/dsh-adapter/channel.ts
  -> Controller
  -> 按 screen/overlay 有界的 readonly projection/ViewModel
  -> pi-tui Component tree
  -> requestRender()
```

硬约束：

- `src/tui/bootstrap.ts` 通过 facade `src/tui/public.ts` 创建 fork 包 `@deepseek-harness-tui/pi-tui` 提供的 `TUI`，inline 使用 `TuiMainScreen`，fullscreen 使用 `TuiAltScreen`；生产渲染必须由它们承载，不能由 dsh 另包 renderer 冒充根 TUI。
- 不自建 frame、cell、layout、compositor、diff、render loop 或 input parser。布局、输入解析、screen diff、滚动和 terminal mode 交给 pi-tui。
- 同一 Terminal 上任意时刻只有一个活跃渲染接管者，禁止并发 TUI。场景、overlay、编辑器 helper 不得创建第二终端、第二 stdin listener 或第二 render loop。唯一例外是 fullscreen 最终退出的顺序接管：原 TUI 已 `stop` 后，在同一 Terminal 上临时 `new TuiMainScreen(ui.terminal)` 重放 transcript（见 1.2），此时不存在并发接管。
- 上游基线唯一固定为 `@earendil-works/pi-tui@0.84.2`，仓库为 `https://github.com/earendil-works/pi`，commit 为 `086c32e74530564922d011ade23ff582c9d63116`。生产唯一使用 vendored fork `@deepseek-harness-tui/pi-tui@0.84.2-dsh.0`，唯一承载目录为 `packages/pi-tui/`。
- `packages/pi-tui/` 是上游 pi-tui 的 vendored fork（workspace 包）。fork 初始差异为零（原样 vendor），fork 差异用 git 历史承载并配最小守护测试；不使用 `patches/terminal-session.patch` 或任何 patch 文件作为机制。之后仅在出现明确 bug 时才做最小本地修复，每次修复都必须是可 rebasing 的最小提交。
- 终端 I/O owner 唯一是 fork 提供的原生 `ProcessTerminal`：它独占 `process.stdin`/`process.stdout` 的 raw mode、Kitty keyboard、bracketed paste、resize、Windows VT、drain、cleanup 和 `StdinBuffer` 协议逻辑。dsh 不注入 stream/writer callback，不复制 terminal session 实现，也不维护任何 dsh 侧 writer。Kimi 已证明删除旧 Ink 链后 pi-tui 自然成为唯一 stdout 生产者，多 writer 问题随迁移消失；因此不存在“所有 terminal write 经 dsh writer”的约束。
- 生产代码只通过 dsh facade `src/tui/public.ts` 导入 fork 包；除 fork 包内 `ProcessTerminal` 及明确 launcher 例外外，任何生产文件不得直接 `process.stdout.write`。
- 旧 `src/ui.ts`、React/Ink/Yoga 根和 fallback 在迁移完成后删除，而不是只从某个入口隐藏。

### 1.2 生命周期

fork 保留 pinned pi-tui 的现有 `TUI.start()`、`TUI.stop({ preserveScreen })`、`TUI.renderNow()`、`TUI.requestRender()` 与 `Terminal.start()`、`Terminal.stop()`、`Terminal.drainInput()`、`Terminal.write()` 等能力；它没有 `quiesce/resume/finalStop/awaitStop`。后四者保留为 dsh bootstrap/adapter 层的组合封装，固定在 `src/tui/lifecycle.ts`，实现完全基于现有 pi API，不能写成需要上游证明的 API。

`src/tui/lifecycle.ts` 是唯一 lifecycle coordinator：所有 signal/update/editor/exit 请求都经它串行（内部一个 promise 链/互斥）；同一操作的重复调用幂等（返回同一 promise）；`finalStop` 建立后所有后续请求 fail closed。

```text
external editor / 可恢复暂停:
  lifecycle.quiesce('external-editor') -> editor -> lifecycle.resume()

update / shutdown / signal / exception:
  lifecycle.finalStop(reason) -> lifecycle.awaitStop() -> child/exit
```

root/overlay 交换不走 `quiesce/resume`：它是纯同步的 pi 组件替换（inline 下 `clear/addChild`，fullscreen 下 `setLayoutRoot`），由 `src/tui/screen-takeover.ts` 负责（参考 Kimi `screen-takeover.ts`），完全不停 terminal、不经 quiesce/resume。原因：`TuiAltScreen.stop({ preserveScreen: true })` 会退出 alt screen，每次切 scene 都拆屏重建是错的。`quiesce/resume` 只保留给 external editor 等真正要把 tty 让给子进程的场景。

- `quiesce`（可恢复暂停）：input gate 布尔置位屏蔽新输入 → `TUI.stop({ preserveScreen: ui.mode === 'fullscreen' ? true : undefined })`；随后子进程（如 external editor）以 stdio inherit 运行。`preserveScreen` 与 Kimi 一致按 mode 传参：fullscreen 才 preserve；inline（`TuiMainScreen`）不 preserve，让 stop 把光标移到内容下方，否则 readline 式编辑器会在 UI 中间画花。
- `resume`：只作用于尚未 `finalStop` 的同一 TUI owner；`process.stdin.pause()` → `TUI.start()` → `requestRender(true)`，并使旧异步结果和旧 generation 输出失效。顺序参考 Kimi `editor-keyboard.ts` 的 `openExternalEditor`：注意 `terminal.stop()` 会清掉 OSC 9;4 进度等状态而 app 侧标志仍为 true，resume 后必须 resync（如重置 progressActive 并刷新对应 UI）。
- `finalStop`：只用于 update、正常退出、signal 和 exception；顺序为 `Terminal.drainInput()` → `TUI.stop()` → child/exit。完成后 `resume` 必须 fail closed。死终端 EIO 由 stdout/stderr 的 error 监听触发 emergency restore + exit。
- stdout flush：Node 的 `stdout.write` 只是同步入队，不代表已写完。`finalStop` 在 `TUI.stop()` 之后、child/exit 之前必须等待 `process.stdout` drain（检查 `writableLength`，必要时 `once('drain')`），等待失败则走 emergency restore；`Terminal.drainInput()` 只排空 stdin，不证明 stdout 写完，stdout 必须单独处理。
- fullscreen 最终退出遵循 Kimi `stopUiForExit` 模式：`ui.stop({ preserveScreen: true })` → 在同一个 terminal 上临时 `new TuiMainScreen(ui.terminal)` 挂载 transcript 容器 → `renderNow()` → `main.stop()`，把完整 transcript 落进原生 scrollback。原因：上游 `TuiAltScreen.stop()` 默认重放的是当前 viewport 一屏而非完整 transcript。
- `awaitStop`：只是等待 drain/stop 完成的 promise 封装，不是新协议；只在 `finalStop` 已建立后调用。
- 注意 `TUI.stop()` 内部会调用 `terminal.stop()`，dsh 侧不得在其后再单独调用一次 `terminal.stop()`。
- pinned `0.84.2` 的 `ViewportTUI` 只有 `setLayoutRoot`；因此 `src/tui/screen-takeover.ts` 自己跟踪当前 layout root（创建时传入的引用由我们自己持有，不从上游 TUI 反查），保持 fork 初始零差异。

### 1.3 Channel、Controller 和 ViewModel

- `src/dsh-adapter/channel.ts` 继续是业务 mutable store 和 DSH 事件真相；不复制成第二份业务 store。
- Controller 是 UI projection 的唯一订阅者，但不生成包含全部业务字段的全局 `TuiSnapshot`。每个 screen/overlay 使用有界 readonly projection/ViewModel，只读取当前界面需要的字段。
- projection 保留 `revision`、`sessionEpoch` 和 `generation`：前者表示相关 Channel 更新，`sessionEpoch` 区分 session/agent projection，`generation` 区分 TUI 生命周期。已有 `emitStream` 的约 16ms 合并行为保持不变。
- projection 使用结构共享和按需读取；消息 `rows` 通过 revision、visible range 或稳定引用更新，不得每个 tick 深拷贝全部 rows 或业务状态。
- `newSession`、`resumeTo`、model/agent 切换和异步 command 必须在完成时检查 session/generation；晚到结果只能丢弃或记录，不能写入新 session、当前 overlay 或 stdout。
- Component 只接收 readonly ViewModel、pi-tui public Component 能力和 typed command sink，不持有 Channel、Cordis、Agent、stdio 或业务 service。

### 1.4 0.9 scene API：单独决策

imperative plugin scene 是 `0.9.0` 的破坏性迁移。本计划允许该决定，但必须把它作为独立决策、迁移和验证保留，不能混入渲染核心的完成条件，也不要求所有插件迁移。

若决定执行，最小范围为：

- 保留 `./scenes` export、`ctx.tuiScenes` 以及 `register/open/close` 控制面形状。
- 只把 scene descriptor 替换为带版本的 imperative factory，例如 `version`、`id`、`create(context)`；context 只提供当前 scene 所需的 readonly ViewModel、typed commands、root/overlay descriptor 和 `AbortSignal`。
- 删除 `./jsx-runtime`；旧 React scene descriptor fail closed 并给出明确迁移提示，不做 fallback、双 descriptor 或隐式版本推断。
- 仅影响 scene 插件；其它插件 API 不因本计划被迫迁移。
- 在 `docs/migrations/0.9.0.md` 提供短迁移说明，并增加 scene 注册、打开、关闭的最小验证；不建立大型插件治理系统。

若 scene 决策不执行，React/Ink 删除后旧 React scene 在 0.9 实际不可用（runtime 拒绝/不可渲染），不能既不做迁移又宣称 scene 可用。

## 2. 当前基线和目标文件

### 2.1 已确认的入口和旧链路

执行 `WP-00` 时以以下文件为事实来源：

- 入口：`src/index.ts`、`src/dsh-adapter/index.ts`、`src/dsh-adapter/plugin.ts`。
- 旧 UI 接管：`src/ui.ts`、`src/ink/**`、`src/native-ts/yoga-layout/**`、`src/screens/**`、`src/components/**`、`src/utils/externalEditor.ts`。
- Channel：`src/dsh-adapter/channel.ts` 的 `subscribe`、`emit`、`emitStream` 以及 session/model replacement 路径。
- 发布配置：`package.json`、`pnpm-lock.yaml`、`scripts/verify-package.mjs`、`scripts/verify-bun-package.mjs`。
- CI/发布：`.github/workflows/ci.yml`、`.github/workflows/publish.yml`。当前 Node 配置保持不变（现有 job 使用 Node 24），不新增 Node 版本矩阵。

当前已有命令不改名，迁移前后都保留：

```sh
pnpm compile
pnpm verify:build
pnpm verify:package
pnpm verify:bun-package
pnpm smoke
```

基线失败只记录原始结果，不通过新增 recorder、artifact 或 shared gate runner 处理。

### 2.2 目标文件和职责

| 范围 | 文件 | 迁移动作 |
| --- | --- | --- |
| pi facade | `src/tui/public.ts` | 只 re-export fork 包实际使用的 public API；生产 pi-tui import 的唯一入口 |
| vendored fork | `packages/pi-tui/**` | 以 pinned upstream 原样 vendor（初始零差异）；fork 差异用 git 历史承载并配最小守护测试；不承载 dsh renderer、layout 或业务 projection |
| 启动和接管 | `src/tui/bootstrap.ts`、`src/tui/screen-takeover.ts` | 创建唯一 TUI + 原生 `ProcessTerminal`，选择 `TuiMainScreen`/`TuiAltScreen`，交换 root/overlay，不创建第二 TUI/Terminal |
| 生命周期 | `src/tui/lifecycle.ts` | `quiesce/resume/finalStop/awaitStop` 组合封装，实现完全基于现有 pi API |
| 状态投影 | `src/tui/controller.ts`、`src/tui/view-model.ts`、`src/tui/commands.ts` | 建立按屏幕有界 projection、命令和 session/generation 栅栏 |
| 组件和屏幕 | `src/tui/components/**`、`src/tui/screens/**` | 将实际使用的组件/屏幕迁移为 imperative pi-tui Component |
| scene/plugin | `src/dsh-adapter/scenes.ts`、`src/scenes.ts`、`src/dsh-adapter/plugin-host.ts`、`src/plugin-host.ts`、`cordis.patch.yml` | 如执行单独决策，接通版本化 imperative scene；控制面形状保持，只替换 descriptor；runtime 只保留一个 owner |
| scene 验证与文档 | `scripts/verify-plugin-commands.ts`、`scripts/verify-plugin-lifecycle.ts`、`scripts/verify-plugin-ledger.ts`、`docs/plugins.md`、`docs/plugins.en.md` | verify:build 链上的这些脚本仍在用旧 descriptor，需随 scene 决策同步更新；文档同步说明新 descriptor |
| 交接和退出 | `src/utils/externalEditor.ts`、`src/update.ts`、`src/dsh-adapter/plugin.ts` | 使用统一 `quiesce/resume` 或 `finalStop/awaitStop` 顺序 |
| 轻量检查 | `scripts/verify-tui-boundary.mjs` | 只做入口、facade 和 stdout owner 边界扫描；workspace dependency 由 `package.json`、`pnpm-lock.yaml` 固定 |
| smoke / focused tests | `scripts/smoke.tsx`、`test/tui/*.test.ts` | 将现有 smoke 改为 fork pi-tui smoke，新增少量聚焦测试 |

## 3. pi-tui 依赖和发布边界

### 3.1 pinned upstream 与 vendored fork

- 上游唯一基线是 `@earendil-works/pi-tui@0.84.2`，仓库 `https://github.com/earendil-works/pi`，commit `086c32e74530564922d011ade23ff582c9d63116`。该 exact npm 版本只作为来源基线和差异比较依据。
- 实际生产包唯一是 workspace vendored fork `@deepseek-harness-tui/pi-tui@0.84.2-dsh.0`，唯一承载目录为 `packages/pi-tui/`。fork 初始差异为零（原样 vendor），后续差异用 git 历史承载并配最小守护测试；不使用任何 patch 文件机制。
- 根 `package.json` 使用 workspace dependency `"@deepseek-harness-tui/pi-tui": "workspace:*"`；`packages/pi-tui/package.json` 固定版本 `0.84.2-dsh.0`，`pnpm-lock.yaml` 固定 workspace resolution。生产代码不得声明或解析 `@earendil-works/pi-tui` 作为 runtime fallback。
- `packages/pi-tui/` 之外不放 pi-tui fork；尤其不得把整套 pi-tui 源码复制进 dsh 的 `src` production 目录。dsh 侧不建立另一套 renderer、layout、diff 或输入实现。

### 3.2 fork 维护与升级规则

- fork 初始为零差异 vendor，初始目标仍是零差异。
- fork 内禁止承载 dsh 业务逻辑（Channel/Agent/session/plugin 语义）；允许对 layout、输入、渲染等通用能力做最小扩展或修复，条件是：配最小守护测试、记录上游同步计划、并优先尝试 upstream 修复。每个改动是一个可 rebasing 的最小提交。
- `getLayoutRoot` 类需求当前仍由 dsh 侧 `src/tui/screen-takeover.ts` 自己跟踪解决（见 1.2）；确需进 fork 时按上一条规则走。
- 上游升级必须先重新核对新的 upstream commit 与当前 pinned commit 的差异，再逐个 rebase 本地改动并重跑守护测试与四个聚焦测试；全部通过前不得更新基线。升级记录保留 upstream base、本地提交列表和验证结果。

### 3.3 package 和 workflow

`WP-05` 修改：

- `pnpm-workspace.yaml`：加入唯一 fork workspace `packages/pi-tui`。
- `packages/pi-tui/package.json`：固定包名 `@deepseek-harness-tui/pi-tui`、版本 `0.84.2-dsh.0`，`private: true` 不单独发布，记录 upstream repository 和 commit。
- 根 `package.json`：在 `dependencies` 使用 `"@deepseek-harness-tui/pi-tui": "workspace:*"`，不声明 `@earendil-works/pi-tui` runtime dependency；保留无关的现有 public exports，按 scene 单独决策更新 `./scenes`/`./jsx-runtime`，迁移完成且无引用后移除 React/Ink 旧依赖。
- `pnpm-lock.yaml`：固定 `@deepseek-harness-tui/pi-tui@0.84.2-dsh.0` 的 workspace resolution；package verification 必须检查该锁定关系。
- 发布边界：fork 不单独发布；发布 dsh root 时通过现有 `bundledDependencies` 机制把 fork bundle 进产物（与现有 `@dsh-std/*` 同机制）。不存在“先发布 patched 包再发布 root”的编排。
- `scripts/with-publish-manifest.mjs` 的 bundled 包清单加入 `@deepseek-harness-tui/pi-tui`（与 `@dsh-std/*` 同款 workspace→exact optional 改写）；fork 的 `native/**`（Windows/macOS prebuild）、`LICENSE`、`README.md` 必须随 fork vendor 进入 `packages/pi-tui/` 并进入最终 tarball；根 `package.json` 的 `files`/`bundledDependencies` 同步更新。
- `scripts/verify-package.mjs`：继续使用现有 package verification；在现有检查中增加 fork 产物（含 `native/**` prebuild、`LICENSE`、`README.md`）已进入产物的存在性检查，以及生产 import 只经 `src/tui/public.ts` facade 的检查；不做真实 tarball install、网络编排或临时发布环境。
- `scripts/verify-bun-package.mjs`：保留现有 Bun package verification，并补充 fork 包 root/scene export 的最小 import 检查（仅在这些 export 实际改变时）。
- `.github/workflows/ci.yml`、`.github/workflows/publish.yml`：在现有 job 中接入 fork 包构建与 root 打包；不新增 publish workflow matrix、不引入共享 gate runner、不上传 acceptance artifact；沿用当前 Node/pnpm 配置。

## 4. 唯一轻量 boundary guard

新增并固定文件：`scripts/verify-tui-boundary.mjs`，package script 为：

```json
"verify:tui-boundary": "node scripts/verify-tui-boundary.mjs"
```

它只做明确的入口文件扫描，不做 dynamic import graph、DTS graph、完整 package graph、migration manifest validator 或 emitted-surface allowlist。扫描范围至少包括：

- `src/index.ts`、`src/dsh-adapter/index.ts`、`src/dsh-adapter/plugin.ts`、`src/tui/bootstrap.ts`、`src/tui/public.ts`、`src/tui/lifecycle.ts`、`src/tui/screen-takeover.ts`、`src/update.ts`、`src/utils/externalEditor.ts`、`packages/pi-tui/package.json`。
- 入口和生产 TUI 文件不得 import React、Ink、Yoga、`src/ui.ts`、`src/ink/**`、`src/native-ts/yoga-layout/**` 或旧 renderer 路径。
- 除 fork 包内 `ProcessTerminal` 及明确 launcher 例外外，任何生产文件不得直接写 stdout，出现即失败；匹配模式除 `process.stdout.write` 外还包括 `writeStream(process.stdout` 以及直接向 `process.stdout` 传 stream 的写入。
- 按三个时间窗口判定 stdout owner：TUI active 时只有 `ProcessTerminal` 写 tty；quiesced 时只有被授权的 stdio inherit 子进程（external editor/update）临时接管；stopped 后由退出/重启逻辑接管。任何窗口之外的直接 tty 写入都是 bug。
- 生产代码不得从 `node_modules` 或任何路径直接 import `@earendil-works/pi-tui`；所有生产 pi-tui import 必须经 `src/tui/public.ts` facade，且 facade 只指向 `@deepseek-harness-tui/pi-tui` workspace fork 包。
- 不得出现第二 renderer、第二 TUI、第二 Terminal 的创建或 fallback；不得保留 React fallback（包括 `render`/`createRoot` 的旧根接管）。fullscreen 最终退出在原 TUI `stop` 后顺序临时 `new TuiMainScreen(ui.terminal)` 重放 transcript 是唯一允许的例外（见 1.2）。

该 guard 只负责最重要的禁止事项；TypeScript、`pnpm compile`、现有 build/package verification 负责常规类型和打包错误。不要把它扩展为迁移台账或全量依赖分析系统。

## 5. 三层验证方案

测试范围只验证新渲染链的启动、输入、更新和退出，不承诺覆盖所有旧 UI 行为。

### 第一层：已有构建和发布检查

继续运行第 2.1 节列出的现有构建/发布命令（`pnpm compile`、`pnpm verify:build`、`pnpm verify:package`、`pnpm verify:bun-package`），不替换成新的 gate。`verify:package` 可包含一次简单 packed package import；不得增加真实 tarball 安装/发布编排。

### 第二层：少量聚焦 TUI 测试

使用项目已有的 Node/tsx 方式和 Node 内置 `node:test`（不引入 Vitest、Jest、Mocha 或其它测试框架）。新增一个最小 `test:tui` script，例如：

```json
"test:tui": "node --import tsx/esm --test test/tui/*.test.ts"
```

只保留以下四个测试文件，实际实现可在不增加范围的前提下合并：

- `test/tui/terminal-lifecycle.test.ts`：pi-tui 的 `Terminal` 是 public 接口且由 TUI 构造注入；测试使用实现该接口的简单 fake Terminal（参考 Kimi 的 VirtualTerminal 思路，但只做简单 fake），不需要 patch upstream。只测 `quiesce -> resume`、`finalStop -> awaitStop` 的组合顺序、stop 后 OSC 进度等状态 resync、以及 generation stale drop；不测 writer FIFO，不做 PTY。
- `test/tui/render-root.test.ts`：fork pi-tui 的 `TuiMainScreen` 和 `TuiAltScreen` 首次渲染选择、一次 resize 后重新 render；只断言新 root 链能更新，不建立 VirtualTerminal/cell-grid oracle。
- `test/tui/input-overlay.test.ts`：核心提交/取消输入、一个 overlay 的打开/关闭和焦点返回；只验证 command sink 与 root/overlay 接通。
- `test/tui/channel-view-model-race.test.ts`：Channel → 按屏幕 projection/ViewModel 在 session 切换、generation 切换和慢异步结果到达时丢弃旧结果；保留 `emitStream` 的合并语义。

raw mode、Kitty keyboard、bracketed paste、resize 等真实终端协议行为由 fork 保留的上游测试套件（见 WP-01）加人工 smoke 共同兜底，dsh 侧不另建 PTY 测试体系。

### 第三层：pi-tui smoke、boundary 和人工终端检查

固定选择“重写现有 `smoke`”，不新增 `smoke:tui`：

- 修改 `scripts/smoke.tsx`，让 `pnpm smoke` 经 facade 启动 fork pi-tui 根、注入 fake Terminal 与最小 fake channel，断言一次启动、输入、状态更新和退出。
- 不把旧 React smoke 的所有场景断言搬过来；旧 UI 行为不是本次迁移的覆盖目标。
- 执行 `node scripts/verify-tui-boundary.mjs`。
- 在当前环境人工运行 `pnpm tui`，确认真实终端可以启动、输入一条消息、看到一次更新、调整窗口大小、正常退出；只做短时基本 smoke，不做 30 分钟 soak。

明确暂不加入：`node-pty`、跨平台 PTY matrix、VirtualTerminal/cell-grid 测试体系、artifact recorder、Node 22/24 双矩阵、长时间 soak。以后出现真实回归时，再为该回归增加最小测试。

## 6. 精简工作包

### WP-00：基线和架构决策

**目标**：冻结入口、Channel、package 和 CI 事实，做出唯一实现选择，不先搭治理框架。

**读取和记录**：

- `src/index.ts` → `src/dsh-adapter/index.ts` → `src/dsh-adapter/plugin.ts` 的当前启动路径。
- `src/dsh-adapter/channel.ts` 的 projection、stream、session/model 切换位置。
- `package.json`、`pnpm-workspace.yaml` 的依赖与 workspace 事实。
- 上游 `https://github.com/earendil-works/pi` 的 `@earendil-works/pi-tui@0.84.2`，commit `086c32e74530564922d011ade23ff582c9d63116`，作为 vendor 来源基线。
- 参考 Kimi 实现（`/home/sisct/Code/oss/kimi-code`）：vendored fork 形态、原生 `ProcessTerminal` 作为唯一 stdout owner、`editor-keyboard.ts` 的 external editor stop/start 顺序、`Terminal` public 接口构造注入。
- `.github/workflows/ci.yml`、`.github/workflows/publish.yml` 的当前 Node/job 配置。

**决策**：

1. 固定上游 `@earendil-works/pi-tui@0.84.2`（仓库 `https://github.com/earendil-works/pi`，commit `086c32e74530564922d011ade23ff582c9d63116`），生产唯一使用 `@deepseek-harness-tui/pi-tui@0.84.2-dsh.0` vendored fork workspace package。
2. 固定 `packages/pi-tui/` 为唯一 fork 承载位置，初始零差异 vendor；fork 差异用 git 历史承载并配最小守护测试，不使用 patch 文件机制。
3. 固定终端 I/O owner 唯一为 fork 原生 `ProcessTerminal`；dsh 不做 terminal-session 注入，不建 dsh writer。
4. 冻结 dsh 生命周期封装：`quiesce/resume` 可恢复，`finalStop/awaitStop` 不可恢复，固定在 `src/tui/lifecycle.ts`；`src/tui/lifecycle.ts` 是唯一 lifecycle coordinator，所有 signal/update/editor/exit 请求经它串行（内部一个 promise 链/互斥），同一操作重复调用幂等，`finalStop` 后 fail closed。实现基于已有 `TUI.stop({ preserveScreen: ui.mode === 'fullscreen' ? true : undefined })`、`TUI.start()`、`requestRender(true)`、`Terminal.drainInput()` 组合；`preserveScreen` 与 Kimi 一致只在 fullscreen 传 `true`，inline 不 preserve（让 stop 把光标移到内容下方，避免 readline 式编辑器画花 UI）。
5. 冻结 `revision/sessionEpoch/generation` 的 race 规则。
6. 选择重写 `pnpm smoke`，不创建 `smoke:tui`；只创建轻量 boundary guard 和四个聚焦测试文件，不创建 manifest、recorder 或 PTY 体系。

**基线命令**：运行第 2.1 节列出的全部命令（含 `pnpm smoke`），记录命令结果即可；不新增 `artifacts/tui-adoption` recorder 或双 Node acceptance 文件。

### WP-01：fork 接入、facade/bootstrap/lifecycle

**文件**：

- `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`packages/pi-tui/**`（vendored fork）。
- `src/tui/public.ts`、`src/tui/bootstrap.ts`、`src/tui/lifecycle.ts`、`src/tui/screen-takeover.ts`。

**步骤**：

1. 在 workspace 注册 `packages/pi-tui`，以 pinned upstream 原样 vendor 建立 `@deepseek-harness-tui/pi-tui@0.84.2-dsh.0`（初始零差异）；记录 upstream 仓库/commit；`packages/pi-tui/package.json` 标 `private: true`。
2. fork 保留上游构建方式（tsgo → `dist` + `.d.ts`），`packages/pi-tui/package.json` 的 `exports`/`main` 指向 `dist`；`pnpm compile`（或 `prepare`）先构建 fork 再 tsc dsh 根。dsh 根 tsconfig 不直接编译 fork 的 TS 源码（rootDir 是 `src`，不能 import fork 的 `.ts` 源），dsh 侧只 import fork 构建产物的类型和入口。
3. 根 `package.json` 使用 `"@deepseek-harness-tui/pi-tui": "workspace:*"`，更新 `pnpm-lock.yaml` 固定 workspace resolution；生产依赖不出现 `@earendil-works/pi-tui` runtime fallback。
4. `src/tui/public.ts` 只 re-export fork 包实际需要的 public API；不得绕过 facade import 上游 private path。
5. `src/tui/bootstrap.ts` 创建唯一 `TUI`（构造注入 fork 原生 `ProcessTerminal`），inline 使用 `TuiMainScreen`，fullscreen 使用 `TuiAltScreen`。
6. `src/tui/lifecycle.ts` 实现 `quiesce/resume/finalStop/awaitStop` 组合封装，严格按第 1.2 节顺序：`quiesce` 用 input gate + `TUI.stop({ preserveScreen: ui.mode === 'fullscreen' ? true : undefined })`，`resume` 用 `process.stdin.pause()` → `TUI.start()` → `requestRender(true)` 并 resync OSC 进度等状态，`finalStop` 用 `Terminal.drainInput()` → `TUI.stop()` 并等待 `process.stdout` drain（fullscreen 最终退出按 Kimi `stopUiForExit` 模式补 transcript 重放，见 1.2），`awaitStop` 只是等待 drain/stop 的 promise 封装；不得在 `TUI.stop()` 之后再单独调用 `terminal.stop()`。
7. `src/tui/screen-takeover.ts` 负责纯同步的 root/overlay 组件替换（inline `clear/addChild`，fullscreen `setLayoutRoot`），不停 terminal、不经 quiesce/resume；当前 layout root 的引用由 screen-takeover 自己持有和跟踪（pinned `0.84.2` 没有上游快照 API），保持 fork 初始零差异。
8. fork 保留上游 `test/` 套件（`node --test`），CI/verify 固定运行 `pnpm --filter @deepseek-harness-tui/pi-tui test`，作为 fork 差异的最小守护。raw mode、Kitty keyboard、bracketed paste、resize 等真实终端协议行为由 fork 上游测试加人工 smoke 共同兜底，dsh 侧不另建 PTY 测试体系。

**退出检查**：`pnpm compile`，确认 workspace dependency 已锁定在 `pnpm-lock.yaml`，并确认 dsh 没有旁路 stdout 或第二 Terminal。不能以自建 renderer 补齐 pi-tui 缺失能力。

### WP-02：Channel/controller/viewmodel

**文件**：

- `src/dsh-adapter/channel.ts`。
- `src/tui/controller.ts`、`src/tui/view-model.ts`、`src/tui/commands.ts`。
- 如业务需要，修改 `src/dsh-adapter/questions.ts`、`src/dsh-adapter/approvals.ts`、`src/dsh-adapter/subagents.ts` 的 adapter 边界。

**步骤**：

1. 保留 Channel 的 mutable ownership 和约 16ms stream 合并；Controller 只生成按屏幕有界的 readonly projection，不生成全局全量 snapshot。
2. 按各 screen/overlay 的需要，把 status、rows、pending、model、tokens、notifications、dialog/question/approval 和当前场景状态分配到对应 projection/ViewModel；rows 使用 revision、visible range 或稳定引用，不能每 tick 深拷贝；不为 UI 再建业务真相。
3. 所有输入进入 typed command sink；Component 不直接调用 Channel/Cordis/Agent。
4. 为 session/model replacement 和慢 command 加 `sessionEpoch`/`generation` 检查，旧 completion 不得污染新 projection。

**退出检查**：完成后可运行 `test/tui/channel-view-model-race.test.ts`；若测试尚未落地，先做类型和静态 review，不声称聚焦测试已通过。

### WP-03：组件和屏幕迁移

**文件**：

- `src/tui/components/**`、`src/tui/screens/**`。
- 实际使用的 `src/components/**`、`src/components/design-system/**`、`src/screens/**`。
- `src/utils/sliceAnsi.ts`、`src/dsh-adapter/sanitize.ts`、`src/sessions/format.ts`、`src/trajectory/format.ts`、`src/cc/markdown.ts`、`src/trajectory/motion.ts` 等仍被生产引用的 helper。

**步骤**：

1. 先迁移启动、消息列表、输入、状态、approval/questionnaire、settings/session/plugin/trajectory 等实际 root/overlay 所需部件，再删除对应 React wrapper。
2. Component 只实现 pi-tui 允许的 `render(width)`、`invalidate()` 和必要的 `handleInput`；宽度、换行、滚动、focus 使用 pinned public API。
3. 不把旧 `Box`、cell grid、layout helper、ANSI parser 或 input parser 改名搬入 `src/tui`。
4. 不为每个旧视觉回归新增测试；只让 WP-05 的 root/input/overlay smoke 和聚焦测试覆盖迁移链路。

**退出检查**：`pnpm compile`，并确认迁移后的组件没有 React/Ink/Yoga、Channel/Cordis/Agent/stdio 依赖。

### WP-04：plugin/scene/editor/update/退出接通

**文件**：

- `src/tui/bootstrap.ts`、`src/tui/screen-takeover.ts`、`src/tui/lifecycle.ts`、`src/dsh-adapter/plugin.ts`。
- `src/dsh-adapter/scenes.ts`、`src/scenes.ts`、`src/dsh-adapter/plugin-host.ts`、`src/plugin-host.ts`、`cordis.patch.yml`。
- `src/utils/externalEditor.ts`、`src/update.ts`。
- 如执行 scene 单独决策，`docs/migrations/0.9.0.md` 和相关 plugin 文档（`docs/plugins.md`、`docs/plugins.en.md`），以及 verify:build 链上仍在用旧 descriptor 的 `scripts/verify-plugin-commands.ts`、`scripts/verify-plugin-lifecycle.ts`、`scripts/verify-plugin-ledger.ts`。

**步骤**：

1. `plugin.ts` 删除旧 React root、Ink instance 和直接 cleanup，改为调用唯一 bootstrap。
2. scene、session browser、settings、subagent、trajectory、approval/questionnaire 只通过 root/overlay descriptor 交换，不自启终端；root/overlay 交换由 `src/tui/screen-takeover.ts` 纯同步完成（inline `clear/addChild`，fullscreen `setLayoutRoot`），不停 terminal、不经 quiesce/resume。
3. external editor 固定 `lifecycle.quiesce('external-editor') -> editor（stdio inherit）-> lifecycle.resume()`；`quiesce` 的 `preserveScreen` 按 mode 传参（fullscreen 传 `true`，inline 不 preserve），与 Kimi 一致；不得在可恢复交接中调用 `finalStop`/`awaitStop`。
4. update、signal、exception 和正常退出固定 `lifecycle.finalStop -> lifecycle.awaitStop`，再做 child/exit；finalStop 后不 resume。fullscreen 最终退出遵循 Kimi `stopUiForExit` 模式：`ui.stop({ preserveScreen: true })` 后在同一 terminal 上临时 `new TuiMainScreen(ui.terminal)` 挂载 transcript 容器 → `renderNow()` → `main.stop()`，把完整 transcript 落进原生 scrollback（上游 `TuiAltScreen.stop()` 默认只重放当前 viewport 一屏）。死终端 EIO 由 stdout/stderr error 监听触发 emergency restore + exit。
5. 若执行 `0.9` scene 单独决策，保留 `ctx.tuiScenes` 与 `register/open/close` 控制面，只替换为版本化 `create(context)`；旧 React descriptor fail closed，删除 `./jsx-runtime`，仅要求 scene 插件迁移；同步更新 verify:build 链上的 `scripts/verify-plugin-commands.ts`、`scripts/verify-plugin-lifecycle.ts`、`scripts/verify-plugin-ledger.ts` 及 `docs/plugins.md`、`docs/plugins.en.md`。

**退出检查**：从 `src/index.ts` 启动时能到达 pinned `TuiMainScreen`/`TuiAltScreen`，并且场景、编辑器、update、退出共用同一个 TUI/Terminal owner。

### WP-05：清理旧链路、聚焦测试和现有验证

**文件**：

- 删除已迁移且不再被引用的 `src/ui.ts`、`src/ink/**`、`src/native-ts/yoga-layout/**`、旧 `src/screens/**/*.tsx`、旧 `src/components/**/*.tsx`、`src/force-production-react.ts`；如 breaking，删除 `src/jsx-runtime.ts`。
- 修改 `src/index.ts`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`packages/pi-tui/package.json`、`scripts/verify-package.mjs`、`scripts/verify-bun-package.mjs`、`scripts/with-publish-manifest.mjs`。
- 新增 `scripts/verify-tui-boundary.mjs`；只验证入口、facade、stdout owner 和单 TUI/Terminal 边界，不新增 manifest validator 或 recorder。
- 修改 `scripts/smoke.tsx`，新增 `test/tui/terminal-lifecycle.test.ts`、`render-root.test.ts`、`input-overlay.test.ts`、`channel-view-model-race.test.ts`。
- `.github/workflows/ci.yml`/`publish.yml` 在现有 job 中接入必要的 fork 构建/bundle、`test:tui` 或 `pnpm smoke`，不改成矩阵。

**步骤**：

1. 先运行 boundary guard 检查旧 import、旁路 stdout 和第二 TUI/Terminal，再物理删除旧 root、旧 facade 和旧 renderer；不得用 alias/fallback 让旧链继续可达。
2. 更新 workspace package、root `package.json`、exports/dependencies/files/bundledDependencies 和 `pnpm-lock.yaml`；`scripts/with-publish-manifest.mjs` 的 bundled 清单加入 `@deepseek-harness-tui/pi-tui`，fork 的 `native/**` prebuild、`LICENSE`、`README.md` 随 fork 进入最终 tarball（见 3.3）；保留 `verify:package`、`verify:bun-package` 的最小 packed import 检查，`verify:package` 增加 fork 产物存在性检查。
3. 完成四个聚焦测试和 `scripts/smoke.tsx` 的 fork pi-tui smoke；测试只覆盖 lifecycle 组合顺序/stale drop、main/alt render、input/overlay、projection race，不引入 node-pty、xterm headless、cell-grid、soak 或 artifact recorder。
4. 将 `verify:tui-boundary` 接入现有 build/verify 流程，保持已有命令名和 CI Node 配置。
5. CI 旧脚本批量处置：删除旧 UI 后，用一次性 grep（如 `grep -l -E "src/ui|src/ink|src/screens/|src/components/|jsx-runtime|native-ts" scripts/**`）生成受影响脚本清单，并与 CI yml 交叉比对。每个脚本只有三类处置：不依赖旧 UI 的业务 gate 原样保留；plugin scene 相关的（如 verify:build 链上的 `scripts/verify-plugin-commands.ts`、`verify-plugin-lifecycle.ts`、`verify-plugin-ledger.ts`）替换为最小的新 descriptor 检查；其余依赖旧 UI 渲染的探针脚本（如 `repro-*.tsx`、`verify-*.tsx` 中的旧 UI 用例，旧 `scripts/smoke.tsx` 已被步骤 3 重写）删除。CI 只跑处置后的脚本，不为每个脚本逐一登记 manifest。
6. 删除原计划中过细的 WP-06/WP-07/WP-08；其中的治理、矩阵、tarball orchestration、artifact 和 release recorder 不再作为迁移条件。

## 7. 最终验收和完成定义

本地按以下顺序执行：

```sh
pnpm compile
pnpm test:tui
pnpm verify:build
pnpm verify:package
pnpm verify:bun-package
pnpm smoke
node scripts/verify-tui-boundary.mjs
git diff --check
```

完成必须同时满足：

- `pnpm compile`、`pnpm verify:build`、`pnpm verify:package`、`pnpm verify:bun-package` 和重写后的 `pnpm smoke` 通过。
- 四个聚焦 TUI 测试通过，且只验证 lifecycle 组合顺序/stale drop（fake Terminal）、main/alt 首帧和 resize、核心输入/overlay、Channel→ViewModel session/generation race；不扩展为 PTY matrix 或大型治理。fork 上游测试套件经 `pnpm --filter @deepseek-harness-tui/pi-tui test` 通过。
- `scripts/verify-tui-boundary.mjs` 通过：核心入口无 React/Ink/Yoga/旧 renderer import，生产 pi-tui import 只经 `src/tui/public.ts` facade 指向唯一 fork 包，除 fork 内 `ProcessTerminal` 及 launcher 例外外无直接 stdout 写入，且不存在第二 renderer/TUI/Terminal 或 React fallback（fullscreen 退出重放的顺序接管除外）。
- 人工当前终端 smoke 已确认启动、输入、更新、resize 和退出可用。
- 生产渲染由 `@deepseek-harness-tui/pi-tui@0.84.2-dsh.0` 的 pinned `TuiMainScreen`/`TuiAltScreen` 承载；没有自建 frame/cell/layout/compositor/diff/input parser，只有一个根、一个 TUI 和一个 Terminal（原生 `ProcessTerminal` 为唯一 stdin/stdout owner）。
- `quiesce/resume` 仍可恢复，`finalStop/awaitStop` 仍不可恢复；它们是 `src/tui/lifecycle.ts` 的 dsh 组合封装，不要求上游提供同名 API。editor、update、signal、exception 和退出路径遵守各自顺序，`finalStop` 前已等待 stdout drain。
- 上游基线准确记录为 `@earendil-works/pi-tui@0.84.2`、仓库 `https://github.com/earendil-works/pi`、commit `086c32e74530564922d011ade23ff582c9d63116`；根 `package.json` 使用 workspace dependency，`pnpm-lock.yaml` 固定 `@deepseek-harness-tui/pi-tui@0.84.2-dsh.0`，fork（含 `native/**` prebuild、`LICENSE`、`README.md`）经 `bundledDependencies` bundle 进 root 产物已验证。
- fork 与 pinned upstream 的来源关系、初始零差异 vendor、git 历史承载差异和升级 rebase 规则已记录；fork 不含 dsh 业务逻辑，通用能力改动均有守护测试和上游同步计划。
- 若执行 `0.9` scene 单独决策，控制面形状保留、旧 React contract 已明确拒绝，迁移说明和最小验证已写出；否则不把 scene 迁移计入渲染核心完成条件。

以下内容明确不是完成条件：

- `node-pty`、跨平台 PTY matrix、VirtualTerminal/cell-grid 测试体系。
- 30 分钟 soak、artifact recorder、Node 22/24 双矩阵和 acceptance artifact 上传。
- dynamic import/DTS/package graph 分析、migration manifest validator、完整 emitted-surface allowlist。
- 真实 tarball install/orchestration、publish hash 绑定、shared gate runner、release recorder。
- API-INVENTORY、完整依赖许可证数据库和全量治理台账；第 3 节要求的最小 upstream base/fork 差异记录仍是完成条件。
- 覆盖所有旧 UI 行为的测试清单。

出现真实回归时，优先在现有 Node/tsx 测试方式中增加一个最小可复现断言，不先扩张治理体系。
