# dsh-TUI Fullscreen 与鼠标适配改进清单

> 交接文档：供后续 AI 实施修复使用。
>
> 审计方法：3 路并行子代理（fullscreen 生命周期 / 鼠标输入管线 / UI 组件
> 交互覆盖）+ 主线程源码逐路径验证。审计 C（UI 组件）子代理已交付完整报告；
> 审计 A/B 子代理超时中断，其主题由主线程亲自验证补全（第二轮补充审计了
> 渲染/生命周期路径与终端层外围文件，见第 9/10 节）。本报告只记录审计
> 证据与修复边界，**本轮未修改 `src/`**。
>
> 现状基线：fullscreen（alt-screen）与 SGR 鼠标支持已具备完整链路——DEC 1049
> 进出、1000/1002/1003/1006 鼠标追踪、SGR/X10 解析、hit-test + onClick 冒泡
> 派发、click-to-focus、双击/三击选词选行、拖拽选择即复制、OSC 8 超链接延迟
> 打开、hover、滚轮经按键系统滚动。缺口集中在 **UI 层消费不足**（点击目标、
> hover、cellIsBlank 零消费）与少量**管线级完善**（滚轮坐标、越界 clamp）。

## 1. 执行摘要

优先级速览：

1. **P0**：阻断型鼠标缺口——工具卡/审批/问卷/计划评审/插件对话框决定行
   不可点（agent 阻塞时鼠标放行不了）；SubagentDashboard 一行接线；以及
   覆盖 15+ 组件的 ListItem/Select 条目行无 onClick。
2. **P1**：ClickEvent 的 cellIsBlank/localCol/localRow 全仓库零消费（消息行
   点空白误触折叠）；SGR 滚轮坐标被丢弃（滚轮路由不感知悬停位置）；
   streaming 行点击不一致；页签/滑块/补全下拉/会话行不可点；鼠标坐标越界
   clamp。
3. **P2**：右键/中键语义、滚轮加速度、hover 节流、hover 事件对象、
   X10 点击兜底、点击帧同步、AlternateScreen 多实例回退。
4. **总体判断**：fullscreen 生命周期与渲染几何（第 10 节）经两轮逐路径
   验证**无 P0/P1 级缺口**——DEC 1049 进出、鼠标追踪、终端模式自愈、外部
   编辑器 handoff、altScreen 渲染几何均已成熟；可完善点集中在 UI 层消费
   不足与少量管线级增强。

## 2. P0：阻断型面板不可点击（agent 阻塞时鼠标放行不了）

### C-13 `src/components/approvals/ApprovalPanel.tsx:76-90`

`1. Yes / 2. No` 决定行**无 onClick**，只能 ↑/↓+Enter 或数字键。agent 正被
阻塞等待批准时鼠标用户无法点击放行。建议：每行 `Box onClick={() =>
onDecide(OUTCOMES[index])}`，hover 高亮 focused 样式（`color="claude"` bold
现成）。

### C-14 `src/components/questions/AskUserQuestionPanel.tsx:287-368`

选项行（单选 ●/○、多选 ◉/○）与自由文本输入行**无 onClick**——鼠标无法作答，
多选打勾（空格键）也无法用鼠标完成。建议：单选=聚焦该行或直接提交（推荐
直接提交，与 ApprovalPanel 手感一致）；多选=toggle checked（复用 setChecked）；
输入行=聚焦（setFocusIndex(options.length)）；hover 高亮 focused 样式。

### C-15 `src/components/questions/PlanReviewPanel.tsx:220-269`

Approve / 继续规划决定行 + 反馈输入行**无 onClick**（数字键 1-9 可快捷提交）。
plan-mode 出口被鼠标堵死。建议：选项行 onClick=submitOption(index)（approve
前校验反馈缓冲区为空的既有逻辑复用）；反馈行点击聚焦。

### C-16 `src/components/ExtensionDialog.tsx:118-131,192-196`

插件 select 列表行 / confirm 两行用 ListItem，无 onClick。建议并入 C-09 的
ListItem 全局修复；confirm 行点击 = 对应布尔决定。

## 3. P0：ListItem/Select 条目行无 onClick——15+ 组件系统性缺口

### C-09 `src/components/design-system/ListItem.tsx:40-122`、`src/components/Select.tsx:42-60`

**所有 picker/对话框共用的条目行**（❯ 焦点、✓ 选中、描述行）无 onClick 属性、
Select 无选中回调。影响面（全部经 grep 确认）：ModelPicker.tsx:45-59、
SkillsPicker.tsx:66-79、ActivityPicker.tsx:31-41、PresetPicker.tsx:35-46、
PlanPicker.tsx:29-36、LangPicker.tsx:27-35、PermissionsPicker.tsx:42-50、
ThemePicker.tsx:102-107、ThinkingToggle.tsx:43-48、WorkspacePicker.tsx:29-40、
WorkspaceMenuPicker.tsx:29-37、WorkspaceFlowPicker.tsx:33-44、
RewindPicker.tsx:64-77,125-138、HistorySearchDialog.tsx:59-77、
ExtensionDialog.tsx:118-131,192-196。

建议：ListItem 加 `onClick?: () => void` + onMouseEnter/onMouseLeave（hover 用
`suggestion` 色前景或浅背景）；Select 加 `onPick?: (index: number) => void`；
各 picker 把 onPick 透传给 Chat，复用现有 Enter 分支的"设焦点 + 应用"逻辑
（如 Chat.tsx:1863-1884 的 model Enter 分支）。HistorySearchDialog 点击行 =
填入并提交；RewindPicker 点击行 = 选中进入确认态（高危操作可双击确认）。

## 4. P0：工具卡无点击目标 + dashboard 一行接线

### C-01 `src/components/messages/AssistantToolUseMessage.tsx:296-380`

工具卡（最高频折叠/展开元素：参数、结果、diff 折叠，内含 `… +N lines
(ctrl+o to expand)` 提示）**完全没有 onClick**；MessageList.tsx:832-845 的
`case 'tool'` 也不传。`(ctrl+o to expand)` 对鼠标用户是死提示。建议：加
`onClick?: () => void` 挂根 Box（同 AssistantThinkingMessage 模式），
MessageList `case 'tool'` 传 `onToggleRow(rowId)`，hover 用 toolCardBackground
系色高亮。

### C-06 `src/components/SubagentDashboard.tsx:99-108`

`SubagentCard` 的 onClick prop 已存在（SubagentCard.tsx:12,30）但 dashboard
渲染时**没传**——点击卡片完全无反应。一行接线：`<SubagentCard ... onClick={()
=> onSelect?.(subagent.agentId)} />` + hover 高亮。

## 5. P1：ClickEvent 的 cellIsBlank / localCol / localRow 零消费

### 证据

- [`src/ink/hit-test.ts`](../../src/ink/hit-test.ts#L62)（计算并写入事件）
- [`src/ink/events/click-event.ts`](../../src/ink/events/click-event.ts#L21)
- [`src/components/messages/AssistantTextMessage.tsx`](../../src/components/messages/AssistantTextMessage.tsx#L28)
- [`src/components/MessageList.tsx`](../../src/components/MessageList.tsx#L721)

### 现状与缺口

`dispatchClick` 正确计算 `cellIsBlank`（点击单元格是否未写入）与
`localCol/localRow`（相对当前 handler 的坐标），但全仓库 grep **无任何组件
读取**（引擎注释写明用途："ignore clicks on blank space to the right of
text, so accidental clicks on empty terminal space don't toggle state"）：

- 消息行 onClick → `onToggleRow(rowId)`，assistant/compact 行 `width="100%"`
  全宽 Box → 点文本右侧大片空白同样触发折叠/展开（误触）；
- 分段/多列控件无法用 `localCol` 判断点了哪一段。

### 已验证的可行性

`isEmptyCellAt`（`src/ink/screen.ts`#L502）只对"packed 双字均为 0"的未写入
单元格返回 true。`AssistantTextMessage` 默认无背景填充 → 空白区未写入 →
`cellIsBlank === true` → `if (!e.cellIsBlank)` 防护有效。注意 isSelected/
isExpanded 时有背景填充（空格非空），防护不生效，可接受。

### 修复要求

1. 业务组件 props 从 `onClick?(): void` 改为 `onClick?(event: ClickEvent): void`
   （AssistantTextMessage / UserPromptMessage / AssistantThinkingMessage /
   SubagentCard / GoalTodoPanel / MessageList 等；类型链 ThemedBox → ink Box
   已支持 ClickEvent 参数）。
2. MessageList 行折叠 onClick 加 `!e.cellIsBlank` 防护。
3. （可选）把 `cellIsBlank` 判定从"未写入"扩展为"无可见内容"（`isCellEmpty`
   语义：空格 + empty style），覆盖背景填充行。

## 6. P1：SGR 滚轮坐标被丢弃，滚轮路由不感知鼠标位置

### 证据

- [`src/ink/parse-keypress.ts`](../../src/ink/parse-keypress.ts#L1208)
- [`src/screens/Chat.tsx`](../../src/screens/Chat.tsx#L1651)
- [`src/components/ModelPicker.tsx`](../../src/components/ModelPicker.tsx#L45)

### 现状与缺口

SGR 滚轮序列 `CSI < 64/65;col;row M` 自带坐标，但 `parseKeypress` 的 wheel
分支只返回 `wheelup/wheeldown` 名字、丢弃坐标。Chat 的 useInput 全局滚动主
ScrollBox：

- help 打开时特判 yield（help 自己的 ScrollBox 处理），其他浮层没有；
- picker（ModelPicker 等）是键盘优先窗口化列表、无 ScrollBox、不消费滚轮，
  且 Chat 的 wheel 分支在 picker 打开守卫**之前**（1651 vs 1679 之后）→
  picker 打开时滚轮穿透滚动背后的 transcript；
- 有文本选区时滚轮平移选区（`disp-wheel-sel` tip）——该路径也不感知悬停位置。

### 修复要求

1. wheel 解析保留 col/row（扩展 ParsedKey 或新增 ParsedWheel）。
2. 派发时按 hit-test 结果把 wheel 路由到悬停处最上层 ScrollBox；
   或先做简化版："最上层浮层优先"路由。
3. 回归：`scripts/verify-wheel-selection.ts`（选区平移语义不得破坏）。

## 7. P1：鼠标坐标越界 clamp

### 证据

- [`src/ink/components/App.tsx`](../../src/ink/components/App.tsx#L683)
- [`src/ink/selection.ts`](../../src/ink/selection.ts#L95)（startSelection 无 clamp）
- [`src/ink/selection.ts`](../../src/ink/selection.ts#L124)（updateSelection 无 clamp）

### 现状

`handleMouseEvent` 对 SGR 坐标只做 `-1` 转 0-indexed，无尺寸 clamp；
`startSelection`/`updateSelection` 也不 clamp，越界坐标直接存入 anchor/focus。
hit-test 的 rect 检查天然 miss（点击侧安全）；但**选区侧**：窗口 resize 变小后
事件队列里的旧坐标、或终端报告异常坐标时，anchor/focus 越界，影响选区渲染
与复制（读取路径依赖边界 clamp 才安全，且部分路径只 clamp row 不 clamp col）。

### 修复要求

1. `handleMouseEvent` 入口对 col/row 做 `[0, cols-1] × [0, rows-1]` clamp
   （尺寸取自当前帧，防御 resize 竞态）。
2. 或（更稳）在 `startSelection`/`updateSelection` 内部 clamp——所有调用方
   一次性受益（含键盘路径 moveFocus）。
3. 补越界坐标的单元测试。

**第二轮补充核实的防护现状**（哪些已有、哪些没有）：
- 已有：`selectLineAt`（selection.ts#L420 越界 row 直接 return）；
  `extendSelection` 的 line 模式（#L455 clamp row）；
  `shiftSelection/shiftAnchor`（clamp [minRow,maxRow] + clamp-debt 追踪）；
  键盘路径 `moveFocus`（ink.tsx 调用方保证 clamp）；hit-test 侧天然 miss。
- 没有：`startSelection`/`updateSelection`（#L95,#L124 无 clamp）；
  `extendSelection` 的 word 模式 fallback（#L451-453 用原始 col，未 clamp）。
- 结论：入口 clamp（方案 1）一次覆盖所有路径，仍是最优解。

## 8. P1：其余 UI 点击缺口（审计 C 提炼）

- **C-02** `MessageList.tsx:738-756`：streaming assistant 行无 onClick，与
  settled 分支不一致（流式期间点击无效、流结束后突然可点）。
- **C-03** 消息行（assistant/user/thinking/compact/subagent）：均无 hover
  反馈；`AssistantTextMessage` 的 `userMessageBackgroundHover` 色板现成未用。
  （cellIsBlank 部分见第 5 节。）
- **C-07** `SubagentDetailScene.tsx:187-229`：summary/output/tools 页签
  无 onClick（只能 ←/→），hover 用 inverse/`color="claude"` 提示。
- **C-10** `EffortSlider.tsx:33-47`：effort 档位是裸 Text，无点击区域
  （点击即 setEffort + 关闭，与 ←/→ 即时应用语义一致）。
- **C-11** `CommandSuggestions.tsx:82-117` / `FileSuggestions.tsx:83-115` /
  `SuggestionCard.tsx:53-62`：补全下拉行无 onClick（只能 Tab/Enter 接受）。
- **C-17** `LoadedContextPanel.tsx:60-63`：有 ▶/▼ 视觉提示但 Ctrl+P only
  （onToggle 已由 Chat 传入，一行接线）。
- **C-21** `screens/SessionBrowser.tsx:527-544`：会话行无 onClick（恢复会话
  只能 ↑/↓+Enter），hover 用 suggestion 色。

## 9. P2：锦上添花

- **M-F3 右键/中键语义**（`src/ink/components/App.tsx`#L707,769）：非左键
  只打断多击链/结束拖拽，无右键菜单（复制/打开链接/收起全部）、无中键粘贴。
  需先定菜单 UI 与定位。
- **M-F4 滚轮加速度**（`Chat.tsx`#L1653）：固定 ±3 行/格，无触控板惯性、
  无高分辨率滚轮聚合。需回归 verify-wheel-selection。
- **M-F6 hover 节流**（`App.tsx`#L701）：按单元格去重，每个新单元格全树
  hitTest；是否需节流/合帧先 profile（虚拟滚动下 nodeCache 命中成本未知）。
- **M-F7 hover 事件对象缺失**（`Box.tsx`#L42-44）：onMouseEnter/onMouseLeave
  回调无参数，组件无法得知悬停位置；可仿 ClickEvent 加 HoverEvent(col/row)。
- **M-F8 X10 点击被吞**（`parse-keypress.ts`#L1216-1226）：不支持 1006 SGR
  的终端只发 X10，其非滚轮事件被明确吞掉（点击/拖拽失效）。X10 编码可逆，
  可解析为 ParsedMouse 或探测降级。现代终端均支持 SGR，优先级低。
- **M-F9 点击帧同步（需验证）**：dispatchClick 用 nodeCache（上一渲染帧的
  rect）对当前 DOM 树 hit-test，React commit 后未渲染的窗口期可能错位；
  是否加 renderNow 或帧号校验需先验证。
- **F-2 AlternateScreen 实例回退**（`AlternateScreen.tsx`#L52）：`instances.get
  (process.stdout) ?? instances.values().next().value`——测试/嵌入式多实例时
  可能拿到错误实例（有注释说明是有意为之的兜底）。P2。
- **C-04** load earlier / show previous Divider 可点但无 hover；
  **C-05** 行点击语义（点击=折叠 vs 键盘=选中+展开，建议点击=seekRow+
  selectedId，产品决策）；**C-08** interrupt 无点击目标；**C-18** PromptInput
  无 click-to-focus、HelpMenu 行不可点；**C-19** BtwPanel 复制 c 键 only；
  **C-20** GoalTodoPanel 无 hover；**C-22** SessionBrowser 确认行不可点；
  **C-23** TrajectoryScene 全场景无 onClick。

## 10. 已完善（无需改动，避免重复排查）

- fullscreen 设置冻结语义（`src/dsh-adapter/plugin.ts`#L454：boot 前生效 /
  boot 后提示重启 / settings 显示本次启动值）；
- AlternateScreen 嵌套防护（`src/screens/Chat.tsx`#L2365）与 unmount 无条件
  清理（`src/ink/ink.tsx`#L1803）；
- 终端模式自愈（`src/ink/ink.tsx`#L1117 reassertTerminalModes：tmux 分离重连 /
  ssh 重连 / 睡眠唤醒后恢复鼠标追踪、kitty 键盘协议深度平衡）；
- 丢失 release 兜底（FOCUS_OUT / 无按钮 motion 两种恢复路径，App.tsx#L640-653,
  L697-700）；外部编辑器 handoff（enter/exitAlternateScreen 处理 nano CSI-u
  兼容、编辑器 rmcup 后重进 alt、post-restore 输入抑制窗口）；
- 选区滚动平移（captureScrolledRows/shiftSelectionForFollow，verify-wheel-
  selection 覆盖）；双击/三击语义、多击链上限 3、click-to-focus；
- **第二轮补充确认（渲染/生命周期路径，均经主线程逐段阅读）**：
  - 渲染几何：`renderer.ts`#L106-113 altScreen 高度钳制（yogaHeight >
    terminalRows 时裁剪并告警日志）；viewport `+1` hack 防 shouldClearScreen
    误判；cursor.y clamp 防 LF 滚屏（#L171-184）；
  - diff 引擎：`log-update.ts`#L255-278 altScreen 专用 DECSTBM 硬件滚动优化
    （BSU/ESU 原子化，tmux/JediTerm 排除）；#L597-598 altScreen 跳过光标恢复
    （下一帧 CSI H 锚定）；#L676-689 JediTerm inline 特例不影响 alt-screen；
  - 帧锚定：`ink.tsx`#L737-743 ALT_SCREEN_ANCHOR_CURSOR + CSI H 每帧自愈
    （tmux status 刷新等外部游标扰动）；#L785-811 BSU/ESU 原子帧 + iTerm2
    cursor-guide 底部停车 + resize 后 ERASE_SCREEN 原子擦除；#L858-867
    altScreen 下声明光标用绝对 CUP 并 clamp 到终端尺寸；
  - 输入泵：`App.tsx`#L457-479 readable 泵 + Bun wedge 防护 + stdin 长间隙
    → reassertTerminalModes；#L389-415 flushIncomplete 重武装（heavy render
    时防孤儿 ESC）；`parse-keypress.ts`#L753-773 孤儿 SGR/X10 尾巴带 ESC
    前缀重合成（X10 字节窗收窄防误吞 `[MAX]` 类输入）；
  - 模式生命周期：`App.tsx`#L306-386 raw mode 引用计数（EBP/EFE/kitty/
    modifyOtherKeys/win32 启用与对称禁用）；`ink.tsx`#L1264-1267
    reenterAltScreen 自愈（SIGCONT/resize/sleep-wake）；#L1231-1250
    detachStdinForHandoff（/update 重启防父子抢读）；
  - 组件层已完善：AssistantThinkingMessage（三种形态均有 onClick）、
    NewMessagesPill（click+hover 双全，唯一 hover 参考实现）、StickyPromptHeader、
    Chat/SubagentMessage、GoalTodoPanel（有 onClick 无 hover 属 P2）；
  - **终端层外围文件（第二轮补读，均确认无 P0/P1 缺口）**：
    - `termio/tokenize.ts`#L247-288 X10 鼠标消费：三字节 ≥0x20 校验防误吞
      CSI DL / PASTE_END、`\x1b[M` 后无参数判定、不完整事件缓冲；
      已文档化 UTF-8 双字节坐标折叠局限（162+ 列无 SGR 终端，罕见）；
    - `termio/parser.ts`：输出侧 ANSI 解析（Ansi.tsx 唯一消费方，只取
      text/link action），mode action 无消费方但属合理（渲染内容不含
      DECSET）；`?1049`/`?47`、`?1000/1002/1003`、`?1004`、`?2004` 映射齐全；
    - `terminal.ts`：DEC 2026 支持矩阵（tmux 排除、VTE≥0.68、Zed/foot/kitty
      等）、JediTerm 显式检测与 DECSTBM 排除、win32-input-mode 排除嵌入式
      xterm.js（issue #215）、XTVERSION SSH 穿透、writeDiffToTerminal 的
      BSU/ESU 包裹 + clearTerminal 拆出同步块（WT viewport-yank 防护、
      claude-code#35580）+ 每帧 SGR_RESET/link('') BCE 防护（issue #10）；
    - `input-suppression.ts`：120ms 单调扩展抑制窗口，use-input 单点消费
      （外部编辑器 handoff 后异步回复防泄漏）；
    - `hooks/use-terminal-viewport.ts`：滚动容器 scrollTop 减法 + cursor-
      restore scroll 补偿，与 log-update 的 scrollbackRows 口径一致；
    - `selection.ts` 剩余原语：getSelectedText 的 noSelect 跳过/尾随空白
      修剪、softWrap 接续 clamp（#L843-855）、captureScrolledRows 窗口
      边界、clamp-debt 追踪（shiftSelection 的 pre-clamp 虚拟行）。

## 11. 现有回归 harness（改动后必跑）

- `scripts/verify-wheel-selection.ts`（已在 build 门禁）：选区 + 滚轮平移语义；
- `scripts/verify-copy-on-select.mjs`：拖选复制；
- `scripts/repro-fullscreen-ghost.tsx`：xterm headless，SGR 滚轮注入 stdin，
  终态等价 + 屏内自洽双预言机——新鼠标回归测试可复用此 harness 形态。

## 12. 实施路线图（一个功能一个 commit）

> 遵循 AGENTS.md：一个改动一个提交；动手前先 `git fetch --all --prune`
> 确认 HEAD；push 用 `--force-with-lease`；提交进 PR 前本地跑受影响门禁
> （`pnpm run build` 含 verify-wheel-selection）。

1. **commit 1（P0，一行）**：C-06 SubagentDashboard 接线 onClick。
2. **commit 2（P0）**：C-01 AssistantToolUseMessage 工具卡 onClick + hover。
3. **commit 3（P0，阻断面板）**：C-13/14/15/16 ApprovalPanel /
   AskUserQuestionPanel / PlanReviewPanel / ExtensionDialog 决定行 onClick
   + hover（一个 commit 或按面板拆分）。
4. **commit 4（P0，基础设施）**：C-09 第一步——ListItem 加 onClick + hover
   能力、Select 加 onPick；回归 `pnpm run build`。
5. **commit 5（P0，接线）**：C-09 第二步——各 picker 透传 onPick 到 Chat，
   复用现有 Enter 分支确认逻辑。
6. **commit 6（P1，基础设施消费）**：ClickEvent 消费——业务组件 onClick
   签名改为 `(event: ClickEvent)`，消息行加 `!e.cellIsBlank` 防护 + hover
   高亮（C-03 + 第 5 节）。
7. **commit 7（P1）**：C-02 streaming 行 onClick；C-17 LoadedContextPanel；
   C-21 SessionBrowser 行（各自独立 commit）。
8. **commit 8（P1，需设计）**：滚轮坐标保留 + 悬停位置路由（第 6 节）；回归
   verify-wheel-selection 与 repro-fullscreen-ghost。
9. **commit 9（P1）**：鼠标坐标越界 clamp（第 7 节）+ 单元测试。
10. **P2 批次**：C-07/10/11 页签、滑块、补全下拉；M-F3 右键菜单（需先定
    UI 方案）；M-F4/M-F6/M-F7/M-F8/M-F9 需先验证/profile。

## 13. 实施记录（2026-08-22，13 个提交 11ce949..HEAD）

> 按第 12 节路线图实施；每项一个 commit，全量 `pnpm run build`（含
> verify:build 18 项门禁 + 新增 verify:pointer-events）通过。

**已完成**：

- **事件模型**（11ce949）：PointerEvent 基类（button 原始字节 + shift/alt/
  ctrl + localCol/localRow）、ClickEvent 继承并规格化按钮位、WheelEvent、
  handler 注册表挂 onWheel、hover 处理器带事件参数（无参回调向后兼容）、
  dispatchClick/dispatchHover 逐 handler 错误隔离。
- **输入管线**（f55ff65）：SGR/X10 滚轮坐标与修饰位保留（ParsedKey.
  mouseCol/mouseRow）、水平滚轮（wheelleft/wheelright）、X10 点击/拖拽
  兜底解析（parseX10MouseEvent，X10 无 release 的降级已在注释与文档
  声明）、handleMouseEvent 入口坐标 clamp、滚轮位置优先路由（App →
  Ink.dispatchWheelAt → dispatchWheel hit-test 最上层 ScrollBox，命中即
  吞掉）、ScrollBox 挂 onWheel 走自身 scrollBy 公共路径、alt-screen 进出/
  resize 时 resetPointerState（清 hover 集/多击链/挂起超链接/收尾中断
  拖拽）。输入抑制窗口内不路由（防 handoff 回放滚轮片段滚动）。
- **实例回退**（fc32bfb）：AlternateScreen 多实例回退收紧到单实例场景（F-2）。
- **浮层滚轮守卫**（2321a7e）：Chat 兜底路径在浮层打开时 yield（M-F2 的
  picker 穿透部分；位置路由部分在 f55ff65）。
- **列表能力**（6682029）：ListItem/Select onClick+hover、九个 picker/
  滑块 onPick、Chat 全部接线（与 Enter 同路径）（C-09/C-10）。
- **阻断面板**（9509f97）：审批/问卷/计划评审/插件对话框/上下文折叠头/
  GoalTodo 折叠头（C-13/14/15/16/C-17/C-20）。
- **转录行**（658225d）：工具卡/streaming 行/子代理卡接线、cellIsBlank
  空白防误触、AssistantTextMessage hover、load-earlier hover（C-01/02/
  03/06/C-04）。
- **回归**（b57eec3）：verify-pointer-events（35 项断言）挂入 build 门禁。
- **其余 P1/P2**（2f67139/e72319f/93a39f9/ae8725b）：SubagentDetail 页签/
  interrupt、BtwPanel 复制行、命令/文件补全下拉、Ctrl+R 历史行、/resume
  会话行（C-07/08/19/11/12/21）。

**明确未做（含理由）**：

- C-05 行点击语义改为聚焦：产品决策，未获用户确认前不改既定交互。
- C-18 PromptInput click-to-focus：焦点管线改造，收益/风险比低，待需要时做。
- C-22 SessionBrowser 确认行点击：破坏性操作，键盘 y/n 已足够，防误触。
- C-23 TrajectoryScene 点击：诊断场景，优先级最低。
- M-F3 右键菜单 / M-F4 滚轮加速度 / M-F6 hover 节流：需先定 UX 方案或
  profile 数据（审计原建议保留）。
- M-F7 hover 事件对象类型已在 handler 层放宽（PointerEvent 参数），Box 的
  props 类型未动（react-compiler 产物，避免 churn；运行时已传参）。
- 1003 动态模式 / TerminalModeLease / OSC 52 分块：性能与重构类，需
  benchmark 与真机验证，本轮范围外。
- X10 点击的 release 缺失是协议限制：选区经 lost-release 恢复路径收尾，
  onClick 仍需 SGR（文档已注明）。
