# 移植 Ink 内核架构地图

本文描述 `src/ink/`（103 个文件）与 `src/native-ts/yoga-layout/` 的渲染内核：
移植来源、渲染管线、布局与测量、输入链、终端协议，以及与发布版 Ink 5.2.0
的结构性差异。行号均以审计基线 b2f4087 为准。

## 移植来源与基线

`src/ink/` 是 **Claude Code 内部 ink fork 的移植**，不是 vadimdemedes/ink 开源
上游。三重证据：

1. `src/ink/ink.tsx:1464-1476` 等处的 `updateContainerSync`/`flushSyncWork`/
   `ConcurrentRoot` 是 react-reconciler 0.33 约定（package.json:97 声明
   `@types/react-reconciler` ^0.33.0，lockfile 解析为 0.33.0），而该
   @types 无这些导出，需要 "ported CC build" ts-ignore 掩蔽（src/ink/ink.tsx:260-261
   注释自写 "0.32.3 declares 11 args"，与 :797 的 "react-reconciler 0.31"
   互相矛盾——版本数字以 package.json 实况 0.33.0 为准）；
2. `src/ink/hooks/use-terminal-size.ts:7` 注释 "Terminal dimensions from the Ink
   app shell (ported from the leak)"；
3. `src/ink/termio/osc.ts:498-500` 的 `supportsTabStatus()` 门控
   `process.env.USER_TYPE === 'ant'`——ant 是 Claude Code 内部代号。

与发布版 Ink 5.2.0 的结构性差异（explicit evidence，仓库内核对）：

| 差异 | 证据 |
| --- | --- |
| 无 Static.tsx / Transform.tsx 组件 | Glob/Grep 全库仅 `src/ink/root.ts:127` 注释提及 "Static write"，组件文件不存在；该注释是移植残留 |
| 无 use-stdout / use-focus hooks | hooks/ 14 个文件无二者；焦点由 FocusManager 类管理，原始输出经 TerminalWriteContext |
| 新增 ScrollBox / NoSelect / RawAnsi / AlternateScreen 等组件 | 见下组件表 |
| 布局引擎换为纯 TS yoga 移植 | `src/native-ts/yoga-layout/index.ts:1-39` "Pure-TypeScript port of yoga-layout (Meta's flexbox engine)"，同步无 WASM |

## 渲染管线

```text
src/ink/root.ts wrappedRender（await Promise.resolve() 保 microtask 边界，src/ink/root.ts:121-135）
  -> Ink.render()：<App> 包 TerminalWriteProvider 后 updateContainerSync + flushSyncWork
     （src/ink/ink.tsx:1464-1476，createContainer 用 ConcurrentRoot，src/ink/ink.tsx:262）
  -> reconciler commit -> resetAfterCommit（src/ink/reconciler.ts:276-344）
     -> onComputeLayout：rootNode.yogaNode.setWidth(terminalColumns) + calculateLayout
        （src/ink/ink.tsx:239-258，提交期布局）
  -> rootNode.onRender -> scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS=16ms,
     leading+trailing)（src/ink/ink.tsx:212-216；deferredRender 为 queueMicrotask(onRender)）
  -> onRender 主管线（src/ink/ink.tsx:420-794）：
     renderer() 建 Frame（src/ink/renderer.ts:44-121，跨帧复用 Output，charCache 持久化）
       - yoga 维度非法 -> 空 frame
       - alt-screen 时高 = terminalRows 溢出 clamp
       - prevScreen 在 absoluteRemoved 或 prevFrameContaminated 时置 undefined 禁 blit
     -> selection/search overlay 注入 StylePool（src/ink/ink.tsx:539-549
        applySelectionOverlay/applySearchHighlight；搜索命中高亮
        applyPositionedHighlight 在 src/ink/render-to-screen.ts:230-249）
     -> 全损伤判定：didLayoutShift || selActive || hlActive || prevFrameContaminated
     -> alt-screen CSI H 锚定
     -> log.render(prevFrame, frame)：diff 生成 Patch[]（src/ink/log-update.ts:173-558）
     -> 5 分钟池重置 -> optimize(diff)（src/ink/optimizer.ts:45-95：merge cursorMove
        :44-52 / collapse cursorTo :54-58 / 超链接去重 :70-77 / 成对取消
        cursorShow-Hide :79-87）
     -> cursor 停放（src/ink/ink.tsx:660-739）
     -> writeDiffToTerminal 单次 buffered write（src/ink/terminal.ts:243-316）
```

写屏基线：`buffer = (useSync ? BSU : '') + SGR_RESET + link('')`，BSU/ESU 为
DECSET/DECRESET 2026 同步输出（`src/ink/terminal.ts:204`）；`SYNC_OUTPUT_SUPPORTED` 模块
加载期判定：tmux 恒 false，iTerm/WezTerm/Warp/ghostty/contour/vscode/alacritty/
kitty/foot/zed/WT/VTE≥6800 allowlist（`src/ink/terminal.ts:76-124`）。

帧 diff（`log-update.ts`）：`LogUpdate.render()` 走 DECSTBM 硬件滚动
（shiftRows + setScrollRegion + csiScrollUp/Down + RESET_SCROLL_REGION +
CURSOR_HOME，:228-251）；shrink/重锚走 `repaintViewportInPlace`（:285-337，修复
#38/#39/#19 重复 UI）；viewportY 之上行跳过（:369-376 计算、:445-447 实际跳过）；
"steady-state scrollback check removed" 注释（:292-297）；
fullResetSequence_CAUSES_FLICKER 定义（:594-604）；non-TTY
`renderPreviousOutput_DEPRECATED` 只发 [NEWLINE]（:92-98）。

## 布局与文本测量链

```text
commitUpdate/markDirty 沿父链向上，只在 ink-text/ink-raw-ansi 叶标 dirty 一次
（src/ink/dom.ts:569-589）
  -> calculateLayout(width, undefined, Direction.LTR)（src/ink/layout/yoga.ts:90-92）
  -> native-ts 纯 TS 单遍 flexbox：generation 计数 + roundLayout；
     4 槽 LRU cacheWrite："Clean nodes' old entries stay" 跨 generation 命中
     （src/native-ts/yoga-layout/index.ts:1387-1508；scroll 热路径 499 条干净消息
     cache-hit）
  -> 文本测量：
     src/ink/dom.ts:445-549 增量 MeasureWrapCache（WeakMap；text.startsWith(cached.text)
       时只重排尾部、只提交完成的行，带 headHeight）
     measure-text.ts 单遍 height += (w===0 ? 1 : ceil(w/maxWidth))
     line-width-cache.ts 按行缓存 stringWidth 且 detachString(Buffer round-trip)
       断 SlicedString
     wrap-text.ts truncate 用 sliceFit 宽字符重试 + '…'
  -> 渲染期 CharCache（src/ink/output.ts:64-120）：MAX_CACHEABLE_LINE=500、16384 entries、
     10 万字符上限，按行缓存 tokenize + grapheme clustering
```

Yoga 移植边界（`src/native-ts/yoga-layout/index.ts:1-39`）：未实现
aspect-ratio / content-box / RTL；`loadYoga()` 保留 async API 兼容 stub
（layout/yoga.ts 注释确认同步无 WASM）；`getYogaCounters` 暴露
visited/measured/cacheHits/live 供性能分析（:1508）。

Screen 模型（`src/ink/screen.ts`）：packed typed-array，每格 2×Int32
（word0=charId，word1=styleId[31:17] | hyperlinkId[16:2] | width[1:0]）+
BigInt64Array 批量 fill + noSelect bitmap + softWrap 每行标记 + damage 区域；
`CellWidth` 枚举 Narrow/Wide/SpacerTail/SpacerHead（:356-367）；diffEach 在
damage rect 内扫描、union prev.damage（:1283-1367）。

输出层（`src/ink/output.ts`）完全重写：Operation 队列（write/clip/unclip/blit/
clear/noSelect/shift）+ intersectClip 嵌套裁剪 + CharCache；flushBuffer 每 style
run 预计算 styleId+hyperlink 并 OSC 8 过滤（:703-737）、`getGraphemeSegmenter().segment`
（:729）；writeLineToScreen hot loop 处理 tab 展开 / CSI-OSC-DCS 跳过 / 零宽
字符 / SpacerHead wide-at-edge / setCellAt（:750-914）。

## 输入链

```text
stdin 'readable' -> App.handleReadable（src/ink/components/App.tsx:434-474）：
    >5s 间隙触发 onStdinResume 重断言终端模式（STDIN_RESUME_GAP_MS=5000）
  -> processInput -> parseMultipleKeypresses(keyParseState, input)
  -> tokenizer（x10Mouse）+ 正则表（src/ink/parse-keypress.ts:23-65）：
     CSI_U_RE（kitty CSI u）、MODIFY_OTHER_KEYS_RE、SGR_MOUSE_RE、
     DECRPM/DA1/DA2/XTVERSION/DECXCPR/OSC 响应解析
  -> 不完整转义序列按 IN_PASTE 用 500ms/50ms 定时 flush
  -> 全部 keys 包进 reconciler.discreteUpdates(processKeysInBatch)
     （src/ink/components/App.tsx:410-417，防 "Maximum update depth exceeded"）
  -> processKeysInBatch 分流（src/ink/components/App.tsx:550-630）：
     response -> querier.onResponse
     mouse -> handleMouseEvent（SGR 1-indexed 转 0-indexed，多击检测，
       hyperlink 延迟 500ms 打开并可被双击取消，xterm.js Cmd+click 让位）
     FOCUS_IN/OUT -> TerminalFocusEvent
     ctrl+z -> handleSuspend（SIGSTOP/SIGCONT 恢复）
     否则 InputEvent.emit + dispatchKeyboardEvent
  -> Dispatcher capture/bubble 两阶段（src/ink/events/dispatcher.ts:46-79，react-dom 式
     unshift/push），getEventPriority 映射 keydown/keyup/click/focus/blur/paste
     -> Discrete、resize/scroll/mousemove -> Continuous（src/ink/events/dispatcher.ts:122-138）
  -> DOM onKeyDown 处理器 + FocusManager Tab 循环（src/ink/focus.ts:105-179，
     focusStack MAX 32 + collectTabbable）
```

`parseKey`（src/ink/events/input-event.ts:31-194）生成 Key 布尔旗标（含 wheelUp/wheelDown/
super），meta 兼容 escape/option；CSI u 与 modifyOtherKeys 与 app keypad 均转成
键名防泄漏 `'[57358u'` `'[27;...'` 等碎片（src/ink/parse-keypress.ts:316-418 keyName
表 / 503-557 keycodeToName 的 PUA 键名；:84-170 为 DECRPM/DA1/DA2/XTVERSION
响应解析区）。

## 终端能力探测与模式断言

```text
setRawMode(true)（use-input useLayoutEffect 同步，src/ink/hooks/use-input.ts:45-93）
  -> App.handleSetRawMode 0->1：写 EBP(2004) + EFE(1004) +
     （supportsExtendedKeys 时）kitty 键盘 CSI >1u + modifyOtherKeys CSI >4;2m
     （src/ink/components/App.tsx:281-368）
  -> setImmediate 延迟 XTVERSION 探测（querier.send(xtversion())+flush，SSH 下
     经 pty 生效）-> isXtermJs()（src/ink/components/App.tsx:327-350）
  -> win32/WT_SESSION 走 hasCursorUpViewportYankBug 规避（src/ink/terminal.ts:195-197）
```

DEC 常量含 2026 同步输出（src/ink/termio/dec.ts:47-74）；`supportsTabStatus()` 门控
`USER_TYPE === 'ant'`（src/ink/termio/osc.ts:498-500，ant-only while the spec is unstable）。

## 组件与 hooks 地图

| 组件 | 语义 |
| --- | --- |
| App = InternalApp（src/ink/components/App.tsx:138 displayName） | 根 Provider 集合：TerminalSize/App/Stdin/TerminalFocus/Clock/CursorDeclaration/ErrorOverview |
| Box | `like <div style=display:flex>`，带 tabIndex/autoFocus/onClick/onFocus/onKeyDown/onMouseEnter/onMouseLeave；Box/Text/Button 由 React Compiler 编译（`import { c as _c } from "react/compiler-runtime"`） |
| Link | OSC 8 超链接（自动 id=osc8Id(url)，src/ink/termio/osc.ts:432-446） |
| Newline | 必须在 `<Text>` 内 |
| RawAnsi | 单个 Yoga 叶 + 常数时间 measure |
| ScrollBox | overflow:scroll + 命令式 ScrollBoxHandle（scrollToElement 延迟到渲染期读 getComputedTop，viewport culling，stickyScroll） |
| NoSelect | 栅栏 gutter（noSelect bitmap） |
| AlternateScreen | useInsertionEffect 进出 alt-screen（用 insertion 而非 layout effect：抢在 resetAfterCommit 的首次 onRender 之前写入 ENTER_ALT_SCREEN，否则首帧写出主屏帧、退出时残留） |

| hooks | 语义 |
| --- | --- |
| use-input | useLayoutEffect 同步开 raw mode + useEventCallback 稳定监听器经 internal_eventEmitter 'input' 事件，isActive 控制（src/ink/hooks/use-input.ts:45-93） |
| use-stdin / use-app | 即 useContext |
| use-terminal-size | 抛错于 App 外；注释 "ported from the leak"（src/ink/hooks/use-terminal-size.ts:7） |
| use-terminal-title | OSC 0，win32 用 process.title |
| use-tab-status | OSC 21337，按 supportsTabStatus 条件发射并 wrapForMultiplexer 包裹（src/ink/termio/osc.ts:510-527） |
| use-terminal-focus | DECSET 1004 终端焦点 |

## 终端协议输出

`src/ink/termio/osc.ts`：关键 OSC 常量（0/2/8/52/99/133/21337，:249-269）；
osc() 在 kitty 用 ST 否则 BEL 终止（:23-26）；wrapForMultiplexer 对 tmux/STY
做 DCS 透传（:43-52）；setClipboard 三路径（native pbcopy/wl-copy/xclip/clip.exe
先发 → tmux load-buffer -w → tmux DCS OSC52 或 raw，iTerm2 去 -w 避 #22432
崩溃，:154-174）；CLEAR_ITERM2_PROGRESS（:473）；tabStatus()（:510-527）。

## 冲突

| 项 | 两侧 |
| --- | --- |
| OSC 21337 门控 vs 注释承诺 | `src/ink/termio/osc.ts:498-500` 只在 USER_TYPE==='ant' 时支持；`src/ink/termio/osc.ts:488-494` 注释声称可无条件安全发射、多终端支持——通用用户永远收不到 tab-status |
| react-reconciler 版本错位 | 源码按 0.33 编写（updateContainerSync/flushSyncWork/ConcurrentRoot），`@types/react-reconciler` ^0.33.0（package.json:97，lockfile 解析 0.33.0）无这些导出，靠 "ported CC build" ts-ignore 掩蔽——类型与实际运行时可能不一致；代码注释自身的版本数字互相矛盾（src/ink/ink.tsx:260-261 写 0.32.3、:797 写 0.31） |
| Static 组件语义残留 | src/ink/root.ts:127 注释提到 "the subsequent Static write overwrites scrollback"，但组件文件不存在——注释是移植残留 |

## 未验证事项

- 公开 API 层如何暴露（ink.tsx 导出表 / index.ts 公共 API 未读导出清单）。
- Bun.stringWidth 运行时依赖：`src/ink/stringWidth.ts:213-216` 在 Bun 存在时优先用
  Bun.stringWidth，否则 JS fallback——项目是否要求 Bun 运行时无法确证
  （node_modules 未安装、禁止运行）。
- render-node-to-output.ts 内部 scroll 状态机（scrollClampMin/Max、
  stickyScroll 恢复）细节未逐行确认。
- events/ 的 click-event/focus-event/resize-event/terminal-event/paste-event
  载荷字段未逐一读取（从 dispatcher/App 用法推断形状）。

相关文档：[overview.md](overview.md)（分层与源码分布）、
[rendering.md](rendering.md)（渲染性能与残影修复）、
[input-commands.md](input-commands.md)（应用层输入模型）、
[origin.md](origin.md)（ink 内核的归属证据）、[unknowns.md](unknowns.md)。
