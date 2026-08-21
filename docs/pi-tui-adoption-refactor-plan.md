# pi-tui 渲染管线迁移实施计划

## 1. 文档目的

本文是 dsh-TUI 的一次性渲染重构计划。目标是把生产 TUI 的渲染、布局、输入和
终端生命周期直接交给 pi-tui，避免项目继续维护第二套 renderer。

文中的“工作包”是实现时的依赖顺序，不是发布阶段，也不要求中间提交可以独立
上线。所有工作在同一个重构分支连续完成，最后以一次完整验收结果合并；不为过渡
架构添加无实际价值的兼容层、双跑链路或临时 renderer。

## 2. 架构决策

### 2.1 当前链路

```text
DSH/Cordis/session
  -> dsh adapter / Channel
  -> Chat.tsx 和其他 React screens
  -> React reconciler + src/ink + Yoga
  -> ANSI 差分输出
  -> stdout
```

当前 `src/ink/` 和 `src/native-ts/yoga-layout/` 共同承担组件树、布局、文本测量、
输入、终端模式和输出差分。它们与业务层交织，导致终端状态和渲染状态存在多个
所有者，修复一个显示问题经常需要同时修改多层缓存和生命周期。

### 2.2 目标链路

```text
DSH/Cordis/session
  -> Channel / controller / ViewModel
  -> pi-tui Component tree
  -> TuiMainScreen 或 TuiAltScreen
  -> PiTerminalAdapter
  -> 唯一 TerminalWriter
  -> stdout
```

- `TuiMainScreen` 用于 inline 模式，保留终端原生 scrollback。
- `TuiAltScreen` 用于 fullscreen 模式，负责固定视口、滚动、选择和 overlay。
- pi-tui 的 `render(width)`, layout、screen diff、synchronized output、输入解析和
  terminal cleanup 是唯一生产渲染管线。
- `TerminalWriter` 是唯一 stdout owner。业务代码、组件和 DSH 服务不得直接写
  `process.stdout`。
- `PiTerminalAdapter` 只负责把 dsh 的受控 stdin/stdout、stderr 通知和生命周期接到
  pi-tui 的 `Terminal` 接口，不重新实现布局或差分算法。

### 2.3 依赖来源

优先使用固定版本或固定 commit 的 `@earendil-works/pi-tui`，并把版本写入 lockfile。
只有出现明确的上游 API 或平台缺陷时才建立 dsh 维护的 fork；fork 必须记录上游
基线、补丁原因和回合并策略。不得把 pi-tui 源码复制成 dsh 自有 renderer。

## 3. 职责边界

| 层 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| DSH/Cordis/session | agent、session、工具、持久化和业务事件 | 终端坐标、ANSI、屏幕 diff |
| Channel | 将事件投影为 transcript、命令动作和状态变更 | 直接写终端、维护第二份会话真相 |
| Controller/ViewModel | 聚合当前屏幕所需状态，订阅 Channel，触发重绘 | 计算终端布局、解析原始 escape sequence |
| pi-tui Component | `render(width)`、组件局部状态、焦点和输入处理 | 访问 DSH 服务、持有 stdout |
| pi-tui TUI | layout、scroll、overlay、focus、screen diff、raw/alt/mouse/paste 模式 | DSH 业务语义 |
| PiTerminalAdapter/Writer | 单一输出通道、背压、启动和清理编排 | 自建 frame/cell/compositor/diff planner |

VirtualTerminal、cell-grid 或 ANSI 录制器只允许用于测试观测和回归断言，不进入生产
渲染热路径。

## 4. 一次性实施范围

### 4.1 根生命周期和终端适配

新增 pi-tui 根装配和 `PiTerminalAdapter`，统一处理：

1. TTY 检查、stdin raw mode、resize 和输入订阅；
2. `fullscreen` 到 `TuiAltScreen`/`TuiMainScreen` 的选择；
3. stdout 单写入队列、背压和错误处理；
4. bracketed paste、mouse、hardware cursor、terminal title 等模式的启停；
5. SIGINT/SIGTERM、异常、外部编辑器交接和正常退出时的幂等 cleanup；
6. 子进程 stderr 继续进入通知/日志通道，不污染 TUI 输出。

根装配完成前不迁移业务屏幕，避免出现一个进程同时运行两套终端生命周期。

### 4.2 视图和交互迁移

把现有 `Chat`、session browser、settings、trajectory、status line、approval、
questionnaire 和各类 overlay 改为 pi-tui Component。每个屏幕拆成：

- controller：处理 Channel 订阅、命令分发、异步动作和状态变更；
- ViewModel：提供稳定、可测试的显示数据；
- Component：只做布局、文本绘制、焦点和局部输入。

输入优先使用 pi-tui 的 `matchesKey`、`Input`、`Editor`、`SelectList`、`ScrollView`、
`showOverlay` 等能力；现有 slash command、session、model、rewind、approval 等
业务语义保持不变。

### 4.3 主题和文本

把现有 theme/i18n 映射为 pi-tui component theme。所有换行、截断、ANSI、CJK 和
emoji 宽度计算统一使用 pi-tui 工具，不在业务组件中调用 `string.length` 推断终端
宽度。Markdown、代码块、loader 和图片等能力优先复用 pi-tui 内置组件。

### 4.4 移除旧生产管线

所有内置屏幕切换完成并通过验收后：

- 删除或移出生产入口中的 React reconciler、`src/ink` 和 Yoga 依赖；
- 删除 `AlternateScreen`、React hooks、JSX runtime 对生产 TUI 的装配；
- 删除 v1/v2 fallback、双渲染、旧 writer 分支和仅为迁移保留的 adapter；
- 更新 `src/ui.ts`、exports、插件文档和构建依赖，使公共 UI 接口明确指向 pi-tui。

若外部插件仍依赖 React UI API，必须在合并前明确版本兼容策略；不能暗中保留一条
第二生产 renderer 来掩盖 API 迁移。

## 5. 实现顺序（同一分支内连续完成）

1. **锁定依赖和契约**：确定 pi-tui 版本/commit，定义 `TerminalWriter`、
   `PiTerminalAdapter`、Controller/ViewModel 接口和 stdout ownership 规则。
2. **接通根生命周期**：建立可启动、可停止、可 resize 的 pi-tui 根，并用最小静态
   Component 验证 main/alt 两种模式、输入和 cleanup。
3. **迁移公共组件**：先迁移文本、主题、markdown、滚动、编辑器、列表和 overlay，
   建立 dsh 组件的显示宽度和焦点约束。
4. **迁移业务屏幕**：按 Chat 主链路、session/settings、approval/questionnaire、
   trajectory/辅助场景的顺序替换屏幕；controller 继续调用原 Channel/DSH API。
5. **切换插件入口**：`src/dsh-adapter/plugin.ts` 只装配 pi-tui 根，验证启动、
   resume、命令、外部编辑器和退出路径；此时不能再从旧 Ink root 启动。
6. **清理旧实现和依赖**：移除 React/Ink/Yoga 的生产路径、无效 exports、迁移胶水和
   旧测试夹具，更新文档与 lockfile。
7. **完整验收后合并**：完成下节测试、性能和人工 PTY 检查后，作为一个完整重构合并。

## 6. 测试与验收

### 自动化

- pi-tui adapter：单一 writer、写入顺序、背压、重复 stop、异常 cleanup；
- ViewModel/controller：session 回放、流式 token、tool 状态、rewind、resume、
  slash command 和 approval/questionnaire 状态转换；
- Component：窄宽度、CJK/emoji、ANSI 样式、换行、截断、滚动边界、overlay 焦点；
- PTY/VirtualTerminal：main/alt screen、首次绘制、增量重绘、resize、空内容、内容
  缩短和连续输入；
- 构建检查：无生产入口导入 React、`react-reconciler`、`src/ink` 或 Yoga；无业务代码
  直接调用 `process.stdout.write`。

### 人工 PTY 验收

至少覆盖 Linux/macOS/Windows Terminal（或对应 CI 终端探针）：

- 启动、连续流式输出、长会话滚动和窄终端；
- main/alt 模式切换、鼠标滚轮、终端原生选择/应用选择；
- bracketed paste、IME 光标、Ctrl+C、Ctrl+J/Shift+Enter、外部编辑器；
- overlay 打开/关闭、resize、SIGINT/SIGTERM 和异常退出后的终端恢复；
- 子进程 stderr、stdout 背压和 30 分钟以上流式 soak；
- 对比迁移前的业务结果，不要求 ANSI 字节逐字相同，但不得出现残影、错位、闪烁、
  丢输入或退出后终端模式残留。

## 7. 非目标和风险

### 非目标

- 不修改 DSH/Cordis、agent、session、tool 或持久化业务语义；
- 不纳入 PR #319 的 remote TUI 能力；
- 不进行视觉重设计；
- 不自建新的 frame/cell/compositor/layout/diff 管线；
- 不保留旧 renderer fallback、双跑或中间发布阶段。

### 主要风险与处理

| 风险 | 处理 |
| --- | --- |
| React 屏幕与 pi-tui imperative API 差异大 | 先抽 controller/ViewModel，再逐个替换 Component；不把 React 状态直接塞进 renderer |
| stdout 有多个写入者 | writer 作为唯一出口；child stderr 和调试日志只走 stderr/通知 |
| raw/alt/mouse/paste 模式泄漏 | 所有入口集中在 adapter，stop/异常路径做幂等回收并用 PTY 复测 |
| IME、CJK、宽度和 overlay 边界回归 | 使用 pi-tui 的宽度工具和焦点协议，固定窄宽度/CJK/IME 回归样例 |
| pi-tui 上游 API 或平台缺陷 | 先固定版本；只有有证据的缺陷才 fork，并隔离最小补丁 |
| 外部插件依赖 React UI | 合并前完成 API 迁移或明确 major 版本边界，禁止隐式保留第二 renderer |

## 8. 完成定义与回滚

满足以下条件才算完成：

1. dsh-TUI 的唯一生产渲染链是 pi-tui；main/alt 模式均由 pi-tui TUI 实例承载；
2. 所有原有核心业务流程和命令通过自动化及 PTY 验收；
3. stdout、终端模式和 cleanup 各有唯一所有者，长会话无已知渲染/内存回归；
4. 生产构建不再依赖 React/Ink/Yoga 热路径，文档、exports、lockfile 与实现一致；
5. 分支工作树通过 `git diff --check`、构建、测试和人工验收。

回滚只在合并边界执行：保留旧分支或回退该完整重构提交。不在生产代码中加入运行时
fallback，也不把未完成的中间工作包当作可发布状态。
