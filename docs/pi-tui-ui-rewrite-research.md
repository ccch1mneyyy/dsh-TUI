# pi-tui UI 重写调研与开工手册

> 这是一份交给 `feat/pi-tui-ui-rewrite` 工作区新会话的 handoff 文档。
> 本文只记录调研结论和实施计划，不是代码变更说明。

## 0. 开工前先读这里

### 目标工作区

UI 重写分支已经单独放在：

```text
/home/sisct/Code/projects/dsh-TUI/.claude/worktrees/ui-rewrite
```

分支：`feat/pi-tui-ui-rewrite`

当前 pi-tui adoption 工作区仍是另一个并行工作区：

```text
/home/sisct/Code/projects/dsh-TUI/.claude/worktrees/pi-tui-adoption
```

不要在 `pi-tui-adoption` 工作区切换到 UI 分支，也不要对它执行 reset、stash、clean 或覆盖式 checkout。调研期间该工作区已经存在其他并行在途修改；这些修改不是本调研产生的，也不能被清理。

新会话应直接以 `ui-rewrite` 作为工作目录启动，避免相对路径误写到另一边。

### 调研基线

| 项目 | commit |
|---|---|
| 当前目标基点 | `093770cd1df9d943e412e9987bae57f360ffcef5` |
| 目标基点主题 | `/fork` 创建独立 root 会话 |
| 源 `origin/main` 最终态 | `33d561bce02fb72c1d65d3e0796147184860f397` |
| 分叉点 / merge-base | `9f9b1def99a044574ed8930cde4b3de3ff51c8f0` |
| 源正式 `v0.9.0` release commit | `aca03b83850d4dc52728d068b2b1b05078ecb90b` |

从分叉点到当前 `origin/main` 是 147 个提交、约 156 个文件、约 +18k 行。源 main 已经把 React/Ink 渲染层继续推进了很多，但目标分支已经完全换成 vendored pi-tui；因此不能直接 merge main，也不能把 main 的 React/Ink UI 提交当作移植补丁。

### 一句话结论

**迁移源 main 的纯业务语义、纯模型、测试 oracle 和共享层修复；在 pi-tui 上重新实现 renderer/UI。**

不可做的事情：

- 不要直接 merge `origin/main` 期待自动得到 UI parity。
- 不要 cherry-pick `src/ink/**`、React 组件、Yoga `MessageList`、Ink pointer/hit-test、Ink Presenter drain。
- 不要在 `packages/pi-tui` 中加入 DSH 的 `Channel`、Goal、FileCandidate、Timeline 等业务概念。
- 不要在 dsh 侧另写一套 SGR mouse parser；`TuiAltScreen` 已经先消费 mouse 序列。
- 不要为了“看起来完成”直接把 fullscreen、scrollbar、性能阈值等产品决策混进 pointer 基础提交。

## 1. 目标 pi-tui 架构事实

### 1.1 生产数据流

当前目标的主链是：

```text
DSH Channel
  -> TuiController（唯一 UI subscriber）
  -> bounded readonly projection / ViewModel
  -> ChatScreen
  -> pi-tui Component tree
  -> ProcessTerminal
  -> TuiMainScreen（inline）或 TuiAltScreen（fullscreen）
```

关键文件：

- `src/dsh-adapter/channel.ts`：业务 mutable state、事件 replay/live projection、session replacement。
- `src/tui/controller.ts`：Channel subscription、structural sharing、revision/sessionEpoch/generation fence。
- `src/tui/view-model.ts`：UI projection 类型和 cache equality。
- `src/tui/screens/chat-screen.ts`：root/dock、transient/picker/settings slot、输入优先级。
- `src/tui/components/transcript.ts`：行组件缓存、折叠、transcript render。
- `src/tui/components/prompt-editor.ts`：pi Editor 封装和 DSH 输入语义。
- `src/tui/public.ts`：唯一的生产 pi-tui import facade。
- `src/tui/bootstrap.ts`：唯一 `ProcessTerminal` / `TuiMainScreen` / `TuiAltScreen` 创建点。
- `src/tui/lifecycle.ts`：quiesce/resume/finalStop 生命周期串行化。

### 1.2 ChatScreen 当前布局

`src/tui/screens/chat-screen.ts` 约 `:382-420`：

```text
fullscreen:
  VStack
    ScrollView(VStack(header, transcript))
      follow=end, primary, overscroll=chain, scrollbar=auto
    bottom dock
      working/activity
      approval/dialog/question
      plugin status
      editor | settings slot | picker slot
      notifications
      status

inline:
  flat VStack(header, transcript, dock entries...)
```

当前 fullscreen 的 `ScrollView` 是构造函数局部变量（约 `:407-418`），后续无法从 `ChatScreen` 查询或控制。时间线、sticky header、pill、Ctrl+O anchor 的第一步都是把它提升为字段，例如：

```ts
private readonly conversationScroll?: ScrollView
```

不要为此复制 Ink 的 `ScrollBox`。pi 的 `ScrollView` 已有：

- `scrollTop`
- `isFollowingEnd`
- `viewportHeight`
- `setScrollbar`
- `scrollTo`
- `scrollBy`
- `scrollToStart`
- `scrollToEnd`
- `updateLayout`

pi 当前缺少或未公开的能力主要是 `contentHeight/maxScrollTop` getter 和 scroll-state subscription；如果确实需要，给 vendored package 加最小、通用、可 rebase 的 API，并单独写 package test。

### 1.3 输入优先级不可破坏

`ChatScreen.handleInput()` 约 `:453-513` 的目标优先级是：

1. plugin/full transient
2. settings
3. slot picker
4. approval/dialog/question
5. `Ctrl+T`
6. `Ctrl+A`
7. `Shift+Tab`
8. `PromptEditor`

任何新键盘或 pointer 路由都必须镜像这个 ownership 顺序：浮层打开时不能把 wheel/click 落到 transcript；确认、删除、rewind 等高风险动作必须走既有 command sink，而不是复制业务动作。

### 1.4 生命周期和 session fence

目标的 session replacement 不是源 main 的旧 React 状态交换。`ee71008` 引入的队列、`sessionEpoch`、`generation`、`fenced()`/`fencedWrite()` 是目标核心，不能被 main 的旧 `channel.ts` 覆盖。

任何异步 UI 功能（文件建议、picker loader、scene、preview）都必须在结果落地前检查：

- request id / AbortSignal
- 当前 `sessionEpoch`
- 当前 TUI `generation`
- 当前 overlay/picker identity

## 2. 必须先处理的共享层（不要和 UI 大合并）

这些不是 UI 重写，但会影响后续所有工作。建议在 UI 分支上单独、原子地迁移，每个主题一个 commit。

### 2.1 上游依赖线和契约

顺序必须是：

1. `ba8c169192116b2118c67e7e2c31fd9730958536` — 0.1.1 双家族契约门控。
2. `1377d48d6929e627c8a453f88e2e9f1d7eb2efcf` — 上游依赖树升到 `0.1.1-rc.2`。
3. 重新以 pi workspace 为基础生成/审计 `pnpm-lock.yaml`，不能直接覆盖目标的 vendored workspace 结构。

原因：启动时的 upstream drift 警告来自 installed `0.1.1-rc.2` 与目标验证旧线不一致。契约先支持两条家族线，再升实际依赖，才不会在中间状态把旧 profile 彻底打坏。

### 2.2 resume 模型路由

提交：`82b395f354405561b08f987a05b7db9990c839fe`

最终语义：日志里记录的 provider/model route 必须回传给 `agents.resume({ agentOptions })`。两条入口都要改：

- 启动 `--resume`：`src/dsh-adapter/plugin.ts` 的 `resolveAgent`（约 `:1164`）。
- 进程内 `/resume`：`src/dsh-adapter/channel.ts` 的 `resumeTo`（约 `:3420`）。
- route 解析可抽到 `src/dsh-adapter/presets.ts` 的 `resolvePersistedRoute`。

规则是“完整显式 route > 完整记录 route”，provider-only/model-only 不能错误拼成半条 route。两条入口必须行为一致。

### 2.3 Goal/Todo 数据层

至少迁移 `8c5c22a85aadb1fda112d0d8396762b90ab3eec6` 的真实事件形状修复，再做 pi UI。

源真实日志是顶层 `goal/change`，不是早期实现假定的 `user/message.source.change`。目标需要：

- `ChannelGoal` / `TodoPanelItem` bounded projection。
- `operation=clear` 清空 goal。
- snapshot 更新 phase/objective/rounds/blocked reason。
- `todo/write` whole-list latest-wins。
- session replacement（new/resume/rewind/model）先清空，再 replay 新 session。
- malformed/unknown event 静默忽略，不盲目 cast。

目标 `src/tui/components/rows/tool.ts` 已能消费 generic `ToolResultView`，所以 goal/todo tool card 的 summarizer 应留在 `channel.ts`，不放进 pi package。

### 2.4 子代理流批处理

可移植的两个提交：

- `19097474d9ea7232feaefeabb546c5fe66e7f7f2`：复用调用方 snapshot。
- `549858a8b76f09bdf90c2d3f668495e678b6cf2b`：把 chunk projection 对齐到 16ms flush。

目标语义：chunk 先更新 store/标记 dirty，`emitStream` flush 前做一次 snapshot + `syncSubagentRows`；tool/result/start/end/interrupt 仍立即 projection。不要重复实现——调研时并行工作区的 `channel.ts` 已出现这条 WIP，开工前先确认当前分支实际状态。

### 2.5 结构化 `@` 文件建议

源提交：`eacc7a9737288c982859ab623f111cc2c4011bc4`，后续 UI/交互依赖：

- `3b93be42`：卡片化 slash/@ 菜单。
- `bf8c3781`：选中行 padding 修复。
- `41300b04`：二/三级补全。
- `e72319f`：建议行点击。
- `0df6c851`：absolute overlay hit-test，防止点击落到 transcript。
- `c6fe925`：建议菜单 wheel 选择和宿主 `onWheel` 透传修复。

可复用纯逻辑：`FileCandidate`、`isPathLikeQuery`、fuzzy subsequence score/rank、`preserveSelection`、路径解析和 bounded directory scan。源逻辑在 `src/utils/fileSuggestions.ts` 与 `channel.ts` 的 `listFileCandidates` 附近。

目标要重做：

- `src/tui/commands.ts` 的 typed `listFileCandidates` query sink。
- `src/tui/components/prompt-editor.ts` 的 provider 和 accept 语义。
- candidate kind/id、async stale guard、selection preservation。
- pi Editor autocomplete 的 imperative UI；不要假设私有 `SelectList` 可直接改。

必须测试：`@src/`、`@./`、`@~/`、绝对路径、Windows `\\`/盘符、quoted whitespace、目录继续补全、文件尾部空格、caret 中间 token、Enter/Tab/上下/Esc、迟到结果、cwd/session cache 失效、symlink cycle 和 generated tree 不挤掉源码。

### 2.6 session ID 和 fullscreen 默认

`b36b51485113e27e1714648dee21cf29fc8a5718` 的 `statusBar.sessionId` 是小型独立 vertical slice：默认关闭，开启后在 status bar 显示 `#` + 前 8 位 agent/session id。目标当前工作区可能已有部分 WIP，先检查，不要重复写。

源 main fullscreen 最终默认是 `true`，但实现行为不是单纯 cherry-pick `a3b0cdd`：实际 schema default 改动在 `646bf22af50312aa116a17a57bd85d61b456aca5`，且涉及 settings apply/freeze/recompose 时序。目标目前默认 `false`，并有自己的 persisted `fullscreen.json` 语义。

**建议最后再把默认值翻成 true。** 在 pointer、timeline、长会话和真 TTY 验收完成前，保持目标当前默认，避免把产品选择和技术迁移混在一起。必须先决定：

- 显式 `cordis.yml:false` 是否最高优先级。
- settings layer 与 persisted pref 谁覆盖谁。
- live `/settings` 改动是立即重启、下一次 boot，还是 `/reload` 生效。
- Chat 的 fullscreen prop 和 root wrapper 如何保持同值。

## 3. 时间线、sticky header 和回底 pill

### 3.1 源最终提交链

以下是语义依赖链，不是建议 cherry-pick UI 的清单：

```text
457dbbaa  sticky prompt header 初版
  -> a643ee2d  mini scrollbar / message node
  -> 295b3c31  Grok timeline rail，替换 mini scrollbar
  -> c9992cb1  rail 覆盖折叠轮次，scrollGutter 三态
  -> 737d03a9  back-to-bottom pill 常驻、Enter/End
  -> 89ec7c77  远距回底、120ms timeline dwell、输入批次合并
  -> 61b73897 / 48099d46 / 61a1765c / e81b4558 / f0f76a84
     长会话窗口、LRU、分帧、跳过恢复动画、上滚流式修复
  -> bc141b99 / ab8824f8  热路径分配和 resume 落点修复
  -> fe2acd96 / 0c37109a  post-release hover 与拖选回归
```

源最终态参考：

- `src/ink/timeline-rail.ts:36-255`
- `src/components/MessageList.tsx:745-862`
- `src/components/TimelineRail.tsx`
- `src/screens/Chat.tsx:2472-2592,2995-3044`

### 3.2 可移植的纯模型

新建 renderer-neutral 模块（建议 `src/tui/timeline-model.ts` 或同等位置），只迁移：

- `TimelineTurn { id, top, preview, folded? }`
- `TimelineSnapshot { turns, activeId, upId, downId }`
- `RailGeometry`、`RailHit`
- eligibility 判定
- tick window geometry
- hit-test
- preview clip/wrap
- active/up/down ownership
- folded turn reveal 语义
- `ScrollGutterMode = 'timeline' | 'scrollbar' | 'hidden'`
- stable row-ID unseen 计数语义

宽度必须使用 `src/tui/public.ts` 暴露的 pi `visibleWidth`/grapheme 工具，覆盖 ANSI、CJK、emoji 和 OSC marker；不能复制 Ink `stringWidth` 假设。

### 3.3 源最终 ownership 规则

资格门：

- 内容确实可滚动。
- 至少 2 个 user turn。
- 终端宽度至少 60 列。
- viewport 至少 3 行。

同一 snapshot 同时提供 rail 和 sticky header 的 active：

- `activeId`：最后一个 `promptTop <= viewportTop` 的 user turn。
- 如果 logo/header 占据顶部、第一条 prompt 尚未到顶，fallback 到第一轮。
- `upId`：最后一个严格 `top < viewportTop` 的 turn。
- `downId`：第一个 `top > viewportTop && top <= maxScroll` 的 turn。
- `top > maxScroll` 的尾部 prompt 不作为 down。
- folded turn 保留为导航候选，但需要 reveal 后再定位，不能把 `top=-1` 直接传给 `scrollTo`。

源最终 cap 是 120 行；目标当前 `TranscriptView` cap 是 300。是否改成 120 是产品/性能决策，不要悄悄改。若降到 120，先接通 Ctrl+E/showAll/loadOlder，否则旧消息会永久不可达。

### 3.4 目标实现建议

1. `ChatScreen` 持有 `conversationScroll`。
2. `TranscriptView.renderRows()` 同步记录精确 `{ rowId, kind, startRow, height, preview, folded }`。
3. header 高度、margin 和 dock 占用必须计入同一个 content coordinate system。
4. 用 `conversationScroll.scrollTop`、`viewportHeight`、准确 content/maxScroll 计算 `TimelineSnapshot`。
5. `TimelineRailView` 只接 readonly snapshot + jump/reveal callback，不读取 Channel。
6. rail/hit/glyph 与 sticky prompt header 只消费同一 snapshot，禁止两个地方各自推导 active。
7. folded click 先 `showAll/loadOlder/reveal`，等待同一布局帧重算，再按 row id 定位；不要照搬 Ink 的 `setTimeout(0)` force-mount race。
8. inline 模式不显示 app rail、sticky header 或 pill。
9. fullscreen 退出 replay 时，rail/header/pill/preview 不能写入 native scrollback；`getTranscriptComponentsForExit()` 语义要保持。

### 3.5 Back-to-bottom pill

最终源语义：

- `showPill = !isSticky`，离底时即使 unseen=0 也显示。
- 有 unseen：`↓ N 条新消息`。
- 无 unseen：`↓ 回到底部（Enter/End）`。
- plain Enter 在离底时回底并阻止本次发送；End 回底。
- overlay/search/history 等更高优先级先消费 Enter。
- unseen 不是“新 rows 数”：离底时保存稳定 row ID，只有 row 顶部进入 viewport 才递减；回底清零。

实施顺序建议先做只显示“回到底部”的 pill，再接 row geometry/unseen 计数。pi 已有 End/`scrollToEnd()`，不要复制源的远距 pending drain；pi 的精确行布局不需要 Ink/Yoga workaround。

## 4. 全终端鼠标：必须先补通用 pi 能力

### 4.1 目标已有能力

`packages/pi-tui` 已有：

- 终端 mouse mode 管理（direct/mux 模式）。
- fragmented SGR/X10 buffer 基础。
- 按坐标 deepest-first 的 wheel 路由、nested ScrollView chain、overscroll contain。
- scrollbar thumb hover/drag。
- content-space selection、双击词、三击行、边缘自动滚动、OSC 8、OSC 52。
- right-click / copy hooks 的 options。
- package `VirtualTerminal` 测试 harness，可注入 SGR、resize、读取 viewport/scrollback。

已有测试主要在：

- `packages/pi-tui/test/tui-alt-screen.test.ts`
- `packages/pi-tui/test/stdin-buffer.test.ts`
- `packages/pi-tui/test/layout.test.ts`

### 4.2 核心缺口

当前 `Component`（`packages/pi-tui/src/tui.ts:23-47`）没有通用 pointer/click/hover handler；layout 只有 ScrollView hit-test，没有普通 component 的 clip-aware、paint-order hit path；overlay geometry 在合成后没有保留可供事件派发的 metadata。

`TuiAltScreen.handleViewportInput()` 会在组件 focus 路由之前消费 mouse/wheel，所以在 `src/tui` 加 `addInputListener` 解析 SGR 是错误方向。

要达到源 main 的 picker/settings/dialog/rail/header/pill/click parity，先在 vendored package 做通用能力，业务留在 dsh：

```ts
interface PointerEvent {
  type: 'press' | 'release' | 'move' | 'click' | 'wheel' | 'enter' | 'leave'
  x: number
  y: number
  localX: number
  localY: number
  button: number
  shift: boolean
  alt: boolean
  ctrl: boolean
  deltaX: number
  deltaY: number
  cellIsBlank: boolean
}

interface Component {
  handlePointer?(event: PointerEvent): boolean | void
}
```

这是设计草案，不是要求原样使用。关键 contract：

1. layout 保存与成功提交 frame 同一时刻的 component rect、clip、parent、paint order。
2. overlay 以 topmost/focus order 先命中；capturing modal 即使没有 handler 也阻止穿透。
3. deepest leaf 到 parent 冒泡，handler 可消费。
4. press 只记录 selection candidate；未形成 drag 的同 cell release 才派发 click。
5. click 被消费后不能复制、不能再次触发 OSC 8；未消费才走既有 selection/link。
6. wheel 先给 topmost component，未消费再走现有 ScrollView route。
7. resize/focus-out/stop/layout target 消失前派发 hover leave，清 capture。
8. handler 异常隔离，不能打死主输入循环。
9. pointer API 从 package root 导出，经 `src/tui/public.ts` facade 重导。
10. 每个 package 改动独立 commit + package-local guard test + upstream sync 说明。

### 4.3 源最终用户点击语义

不要移植早期“所有消息行可点击”的状态；最终 main 已撤销普通 user/assistant 行的 click/hover：

- 普通 user/assistant 文本：纯阅读，保留拖选。
- thinking（含 streaming）、compact、tool card：点击折叠/展开，右侧空白不触发。
- subagent card：进入详情；dashboard/detail tab、interrupt、close 可点。
- picker/Select/settings/approval/question/plan/extension：click 复用 Enter/keyboard action。
- completion/history/resume/session tree：稳定 ID 行点击；确认页才执行高风险操作。
- trajectory：tabs、ledger、hotspot、axis、query、WaveBand、wheel、close。
- PromptEditor：按真实 wrapped row/column、CJK/emoji/grapheme 计算 caret。
- timeline/header/pill/gutter：跳转或 reveal。
- drag selection release 不能触发业务 click。

tmux/Zellij 下通常没有 passive hover（只开 1002），所以 click/wheel 必须完整，hover 只能优雅降级，不能把 hover 作为所有终端的硬验收条件。

### 4.4 pointer 分阶段

不要把 pointer core 和业务 UI 混成一个 commit：

1. package generic event/type + layout hit-test。
2. SGR/X10/clamp/hover/click-vs-drag/overlay dispatch + package tests。
3. dsh 阻断型 dialog/approval/question。
4. picker/completion/session browser/settings。
5. prompt caret。
6. transcript card、trajectory、session tree、timeline/pill。
7. hover cosmetic 和 host wiring。

先接 `src/tui/plugin.ts`/bootstrap 的 `mouse`、`openUrl`、`copySelection`、`onRightClickPaste` options；不要假设现有 `src/utils/clipboard.ts` 已提供写入系统剪贴板。

`DSH_TUI_DISABLE_MOUSE` 的语义也要单独决定：源实现是禁 click/selection，但 wheel 仍可作为 key path；简单传 `mouse:false` 会连 wheel 一起关掉，不等价。

## 5. 性能：先建立 pi 基线，不要照搬 Ink 优化

### 5.1 源 main 的重要事实

主要提交链：

```text
61b73897  fullscreen 尾窗 + Markdown token bounded cache
48099d46  wrapText bounded cache
61a1765c  分帧补画、render cap 300 -> 120
 e81b4558  长 resume 跳过 whale 开场动画
 f0f76a84  上滚 + streaming 时不重挂不可见流式行
 bc141b99  MessageList 热路径减少 O(n) 分配
 ab8824f8  resume 最新行可见/End 可达
```

源测量曾观察到：

- wrap cache 的 Yoga 总耗时约 `8968ms -> 645ms`。
- 分帧/cap 的 inline 打开静息约 `6027ms -> 2026ms`。
- skip intro 的 fullscreen 打开约 `6694ms -> 1118ms`。
- streaming offscreen 失效的 3 秒/约 91 chunk 场景约 `2674ms -> 13ms`。

这些数字是源提交作者的 Ink/Yoga 基准，本调研没有重跑，不能直接作为 pi 目标承诺。

### 5.2 pi 对应路径

目标 pi 的真实热点：

- `src/tui/components/transcript.ts:90-114`：每个 channel revision 全量 rows 扫描、创建 `Set`、拼 fingerprint。
- `src/tui/components/rows/shared.ts:82`：fingerprint 未包含完整 subagent 状态，且 in-place alias 可能让变更不失效。
- `src/tui/components/rows/assistant.ts`：streaming 每 chunk 可能全文 lexer/wrap。
- `packages/pi-tui/src/layout.ts`：ScrollView child 仍先完整 render lines，再裁 viewport；当前不是 source 式 virtual row provider。
- `packages/pi-tui/src/tui.ts:764-824`：已有约 16ms render coalescing；input/force render 有 immediate path。
- `packages/pi-tui/src/tui-alt-screen.ts:1246-1313`：两遍 layout/render，写 changed viewport rows。
- `packages/pi-tui/src/terminal.ts:482`：直接写 stdout，无源 Presenter backlog gate。

### 5.3 推荐顺序

1. 先复制 source fixture，建立 pi 原生 baseline：cold open、first frame、settled、scroll p50/p95/max、written bytes、writes、heap。
2. 修 `TranscriptView` 的结构化 stamp/append-only fast path，减少 `Set` 和字符串 fingerprint；明确包含 subagent status/tool/output/error/token 等消费字段。
3. 长恢复动画：长 transcript 首次 projection 到达时 settle `HeaderView`，新会话和 `/deepseek` 主动动画不能受影响。
4. 先接通 Ctrl+E/showAll/loadOlder，再讨论 cap `300 -> 120`。
5. 做 pi 原生 stable-prefix/append-aware streaming renderer；上滚时暂缓不可见尾部全文 rebuild，回底/settle/resize/search/copy/exit 时追平。
6. profile 仍显示 lexer/wrap 热点时，才增加安全 bounded cache：
   - pi `wrapTextWithAnsi` 返回可变数组，缓存必须 freeze/clone，不能共享可变数组。
   - pi Markdown token 会被原地 trim，token cache 必须 immutable/clone，不能直接照搬源数组 LRU。
7. 最后才评估 virtual document 和 stdout backlog。没有 benchmark 证据时不要搬 source 的 4ms drain/8KB gate；pi 没有 pending scroll drain，错误加 gate 会阻塞键盘和普通流式帧。

### 5.4 当前目标已存在的性能优势/约束

- pi 已有约 16ms 合帧和实例级 render cache。
- pi ScrollView 是精确字符串行几何，不需要 Ink 的 pending spacer、Yoga clamp、force-mount timer。
- Transcript entries 当前保留全部 rows，降低 cap 不等于降低所有内存。
- progressive prepend 可能和 main screen 的按索引 diff/scrollback 冲突，不能只在 `TranscriptView` 里 slice。
- 背压时不能先把 `previousScreen` 更新成实际上未写出的 frame。

## 6. 其他 main-only UI 功能的迁移顺序

### 6.1 建议顺序

#### M1：shared contracts/data

每项独立 commit：

1. contract 0.1.1 family gate。
2. dependency/lock 0.1.1-rc.2。
3. resume recorded route。
4. top-level goal/change fold。
5. subagent snapshot reuse + 16ms projection。
6. structured file candidates。

#### M2：pi-native keyboard vertical slices

1. `statusBar.sessionId` 静态短 ID。
2. Goal/Todo bounded projection + imperative panel。
3. PromptEditor structured @ keyboard behavior。
4. built-in slash/model/effort vocabulary/cache。
5. Ctrl+O/showAll、Ctrl+E、Ctrl+R、loadOlder、back-to-bottom keyboard path。

#### M3：generic pointer

只改通用 pi package，再逐个接 dsh 业务组件。

#### M4：timeline/gutter/pill

先纯 model，再精确 row map，再 rail/header/pill，再 pointer/hover。

#### M5：profile-driven performance

只迁移有 pi 基准证明收益的优化。

#### M6：fullscreen 默认、CI、文档和发布

默认值最后翻转；建议以 `0.10.0-alpha/beta/rc` 发布，而不是继续假定这是无破坏的 0.9 patch。原因是 renderer、scene descriptor、package surface 都已变化。

### 6.2 Goal/Todo imperative view

源 `GoalTodoPanel.tsx` 不能搬。建议新建 `src/tui/components/goal-todo.ts`：

- `update(projection)`、`render(width)`、`invalidate()`。
- elapsed 使用 component-local timer，goal id 首次出现起表，complete 停止。
- `dispose()` 清 interval，session replacement/goal id 变化不留旧 timer。
- working 时显示 completed；idle 时隐藏 completed。
- 无 goal 且全 completed 时隐藏。
- 最多 8 行，剩余显示 `… N more`。
- collapsed 显示 `▸ ✓ done/total` 和 in-progress preview。
- Ctrl/Cmd+Q 与 header toggle 共用一个 ChatScreen UI-local 状态。

projection 必须从 Controller/ViewModel 传入，Component 不能读 Channel/Cordis。

### 6.3 statusBar.sessionId

源语义：默认 false，开启后 status 右组显示 `#${agentId.slice(0, 8)}`；minimal mode 隐藏；窄终端安全截断；`/resume`、`/new`、model/session swap 后必须及时更新。最终 hover full ID 是 pointer 阶段的附加功能，不应阻塞静态短 ID。

### 6.4 structured @

先做 keyboard parity，再做源样式 card/click/wheel。pi Editor 已有 async provider、AbortController、request id、snapshot validation，可以复用 stale-result 思路；但其内部 autocomplete `SelectList` 对 selection identity/private geometry 暴露不足，必要时新建 dsh wrapper，不要把 DSH 业务塞进 package。

## 7. 推荐 commit 划分和验收

### M0：冻结基线

目标 UI worktree 先运行并记录：

```bash
pnpm compile
pnpm --filter @deepseek-harness-tui/pi-tui test
pnpm test:tui
pnpm verify:build
pnpm verify:package
pnpm verify:bun-package
node scripts/verify-tui-boundary.mjs
pnpm smoke
git diff --check
```

不要把并行工作区的 dirty WIP 当成 M0 已完成；先在 UI worktree 确认 clean HEAD 和实际测试结果。

### M1：shared layer

建议 commit：

```text
feat(compat): validate 0.1.1 prerelease family
chore(deps): pin upstream tree to 0.1.1-rc.2
fix(session): restore persisted route on both resume paths
fix(goal): fold top-level goal/change events
perf(channel): reuse subagent snapshots
perf(channel): batch subagent stream projection
feat(files): add structured file-candidate query
```

### M2：keyboard/data UI

```text
feat(status): show short session id
feat(tui): add imperative goal/todo panel
feat(tui): use structured file candidates in prompt editor
feat(tui): wire transcript expand/history/load-older keyboard paths
feat(tui): add back-to-bottom keyboard behavior
```

### M3：package pointer

每一项单独可 rebase：

```text
feat(pi-tui): add generic pointer event contract
feat(pi-tui): dispatch pointer events through layout/overlay hit regions
test(pi-tui): guard click-vs-drag/hover/overlay ownership
```

先跑：

```bash
pnpm --filter @deepseek-harness-tui/pi-tui test
```

### M4：dsh pointer consumers

按风险拆：

1. approval/question/plan/plugin dialog。
2. picker/completion/session browser。
3. settings/trajectory/session tree。
4. prompt click-to-caret。
5. tool/thinking/compact/subagent cards。
6. timeline/header/pill/gutter。
7. hover cosmetics。

### M5：timeline + pill + performance

```text
feat(tui): add renderer-neutral timeline model
feat(tui): add pi-native timeline rail
feat(tui): add scroll gutter preference
feat(tui): add back-to-bottom pill and unseen anchor
perf(tui): reduce transcript reconcile allocations
perf(tui): optimize streaming markdown after benchmark
```

### 每阶段最低验收

- `pnpm test:tui`
- `pnpm --filter @deepseek-harness-tui/pi-tui test`
- `node scripts/verify-tui-boundary.mjs`
- `pnpm compile`
- `git diff --check`

相关功能必须加入目标自己的 `node:test` / `VirtualTerminal` harness，不能只引用源 Ink 的 `*.tsx` 脚本说“已覆盖”。

## 8. 回归矩阵

### 功能

- 40x8、60x18、80x24 的中英文/CJK/emoji 布局。
- inline/fullscreen 启动、resize、`/resume -> Esc`、`/reload`、external editor。
- Ctrl+C/Ctrl+D、SIGINT/SIGHUP、异常退出后的 raw mode、cursor、mouse tracking、bracketed paste、alt-screen 恢复。
- 600+ rows、多 tool card、长 markdown、thinking、subagent running/settled。
- 上滚时继续 streaming；回底后文本完整且不跳视口。
- resume 最新消息末行可见，End 可达。
- overlay/search/history/picker/approval/question/session tree/trajectory/settings 的输入 ownership。
- 普通 transcript 拖选、双击词、三击行、OSC 8、OSC 52；click 与 drag 不串。
- CJK/emoji/combining、多行 wrapped prompt 的点击定位。
- tmux/Zellij/Screen hover 降级；wheel/click 仍可用。

### 性能建议指标

先冻结同机 baseline，再用相对阈值。RC 之前可参考：

- open、p95 frame、写字节、分配量相对 baseline 不回退超过 20%。
- input-to-frame p95 < 50ms，不能持续出现 >100ms 单帧。
- 无动画 idle 60s 零 frame/零 TTY byte。
- 多次 open/resume/scroll/close + GC 后 retained heap 不单调增长。
- resize/streaming 最终画面逐行等于同尺寸冷渲染。
- finalStop 不命中长 transcript drain timeout。

### 真 TTY

至少验证：

- Linux：xterm/kitty/WezTerm，tmux 内外。
- macOS：Terminal.app/iTerm2。
- Windows Terminal + ConPTY。
- Node 22.19 和 Node 24。
- SSH/断连恢复至少一轮。

## 9. 当前调研的限制与事实边界

- 本调研是静态代码和 git 历史审阅，**没有在调研过程中运行 build/test**。
- 源 main 的性能数字来自源提交/基准记录，不是 pi-tui 目标保证。
- 当前 `pi-tui-adoption` 工作区在调研期间有并行 dirty 文件；文档结论以 clean `093770c` 为目标基线，不能把那些 WIP 当成已验收实现。
- `packages/pi-tui/README.md` 可能有上游 trailing whitespace；不要在业务提交中顺手清理 vendored 上游文件，若需要处理应单独记录 upstream exemption。

## 10. 新会话的第一步

在 UI worktree 中执行：

```bash
cd /home/sisct/Code/projects/dsh-TUI/.claude/worktrees/ui-rewrite
git branch --show-current
git status --short
sed -n '1,220p' docs/pi-tui-ui-rewrite-research.md
```

然后先做 M0 基线，不要直接开始改 timeline 或 pointer。M0 通过后，优先从 shared layer 或纯 renderer-neutral timeline model 开始；所有 `packages/pi-tui` 改动必须单独提交并通过 package test。
