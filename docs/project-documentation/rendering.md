# 渲染链路与性能

本文覆盖两块：渲染链路（双层节流、虚拟化、残影修复、TPS 计算）与 CJK
文本测量体系（stringWidth、换行/截断、显示宽度缓存）。行号均以审计基线
b2f4087 为准。

## 双层 16ms 节流

流式 chunk 的渲染有两层节流：

| 层 | 位置 | 行为 |
| --- | --- | --- |
| channel 帧对齐 emit | `src/channel.ts:1114-1125` | `emitStream`：`version` 同步自增，但 listeners 每 16ms 尾部窗口最多触发一次（setTimeout 16ms + timer.unref）；触发时执行 foldRows(MAX_ROWS=600) 再通知 |
| Ink scheduleRender | `src/ink/ink.tsx:212-216` | `throttle(deferredRender, FRAME_INTERVAL_MS=16, {leading:true,trailing:true})`；deferredRender 为 `queueMicrotask(onRender)`——微任务延迟使 onRender 在 layout effects 提交之后执行，物理光标跟随无按键滞后 |

事件分派分流（`src/channel.ts:2942-2945`）：assistant/chunk（每 token 一个
事件）走帧对齐 emitStream 路径，其余事件同步 emit。滚动 drain 帧以
`FRAME_INTERVAL_MS >> 2`（4ms，约 250fps）用普通 setTimeout 调度
（`src/ink/ink.tsx:750-764`），onRender 顶部先清除未决 drainTimer 防双重渲染。

流式端到端链路：

```text
assistant/chunk 事件（src/channel.ts:2944）
  -> ensureStreaming(event.seq).text 原位累加（src/channel.ts:2572-2573）
  -> emitStream：version+=1 同步，16ms 尾沿触发（src/channel.ts:1114-1125）
  -> src/screens/Chat.tsx:118 useSyncExternalStore(channel.subscribe, () => channel.version)
  -> React commit -> resetAfterCommit（src/ink/reconciler.ts:276-344，onRender 调用
     在 :333）
  -> onComputeLayout：Yoga 全树 calculateLayout（src/ink/ink.tsx:239-258）
  -> MessageList 窗口计算 -> MemoRow 跳过未变行 -> StreamingMarkdown 只重解析末块
  -> scheduleRender（16ms 节流）-> microtask onRender
  -> renderNodeToOutput -> Output.get() -> LogUpdate 差分 -> optimize -> writeDiffToTerminal
  -> 帧后 useLayoutEffect 测高入缓存、推 base、setClampBounds（src/components/MessageList.tsx:214-247）
```

## 消息列表虚拟化

布局级虚拟化（提交 7b425de，2026-08-06，根因 = 纯 JS Yoga 任意提交全树重排，
O(全会话) → O(可视窗口)）：

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 渲染上限 | `src/components/MessageList.tsx:28-30` | MAX_RENDERED_ROWS=300（CC 的 MAX_MESSAGES_WITHOUT_VIRTUALIZATION 等价物），旧行折叠到 Divider 之后，Ctrl+E 展开 |
| 虚拟化常量 | `src/components/MessageList.tsx:32-43` | OVERSCAN_LINES=8、DEFAULT_ROW_HEIGHT=2（首测前回退）、DEFAULT_HEADER_LINES=14（冷启动头部估计，首次布局测量后校正）；屏幕外行渲染为固定高度占位符，子树不参与 Yoga 布局 |
| 高度缓存 | `src/components/MessageList.tsx:114-134` | HEIGHTS_CACHE_MAX=5000，FIFO 逐出（行 id 单调增长且 foldRows 不删行，无上限会每行永远增长一条）；宽度变化清空缓存 |
| 窗口计算 | `src/components/MessageList.tsx:159-178` | 挂载「已提交位置 ∪ in-flight pending 区间」+ overscan；sticky 时 end=全部行且强制保留尾部行挂载——防估算高度不足导致卸载全部 → 内容塌缩 → scrollTop 被拉 0 的自维持乒乓 |
| 占位 | `src/components/MessageList.tsx:186-188,264-273` | topPad/bottomPad 保持滚动几何（总高度/粘性跟随/滚动条）；顶部还有 foldRows 的 load-earlier Divider |
| 提交后测量 | `src/components/MessageList.tsx:211-247` | useLayoutEffect 测挂载行 Yoga 高度入缓存、从首个挂载行 getComputedTop() 推导 base、setClampBounds 把渲染期 scrollTop 钳到已挂载覆盖范围（防快速滚动进空白占位区） |
| MemoRow | `src/components/MessageList.tsx:320-328,573` | 把原位可变行拍平为原始 props：channel 就地改 text/status，行对象同一性永远不变，只有变更行 O(1) 浅比较后重渲——修复前每个流式 chunk 重渲全部挂载行并重跑 markdown 管线 |

## resticky：触底恢复

提交 49cc660 / 113ff7d（2026-08-14）："全屏流式空白抖动 + 滚到底部
new-messages pill 不消失"。

```text
滚轮上翻（src/screens/Chat.tsx:858-861）handle.scrollBy(-3)——指令式，无 React 重渲
  -> src/ink/components/ScrollBox.tsx:140-151：el.stickyScroll=false、pendingScrollDelta 纯累加、
     scrollMutated（markDirty+markCommitStart+notify+microtask scheduleRenderFrom）
  -> src/ink/render-node-to-output.ts:876-895 drain pendingScrollDelta（cap innerHeight-1；
     4ms drain 帧）
  -> 滚到底两个重贴点：
     1. src/ink/render-node-to-output.ts:921-936：drain 落定当帧，手动滚动精确触底立即恢复
        sticky（stickyScroll===false && pending 清空 && scrollTop>=maxScroll）
     2. src/ink/render-node-to-output.ts:830-853：无增长帧位置式判定——位置已在 prevMaxScroll
        且内容未增长也恢复跟随（wheel-down 精确触底时 pill 清除）
  -> 重贴守卫：sticky 标志确为显式打断（===false）且 scrollTopBeforeFollow >= prevMaxScroll
     （:847-853）
  -> onStickyRestore 通知：src/ink/dom.ts:95-101 定义（渲染器自行恢复时经它通知
     useSyncExternalStore 订阅者重读快照，否则 pill 永不消失）；src/ink/components/ScrollBox.tsx:216-223
     挂载时 el.onStickyRestore = notify
  -> src/screens/Chat.tsx:193-198 useSyncExternalStore 重读 isSticky -> 头部/pill 翻转
```

shrink 帧冻结（`src/ink/render-node-to-output.ts:806-823`）：虚拟化瞬时收缩（尾部卸载+
陈旧高度缓存占位）是测量伪影而非真实内容损失，该帧冻结位置、不钳到 shrunken
maxScroll，只以可信 maxScroll（scrollPrevMax）做 at-bottom 检查（opentui #709
同款根因：内容尺寸变化不得重置手动滚动状态）。

pill 计数（`src/screens/Chat.tsx:200-219`）：Chat 以行 id 锚定「已看到」位置（loadOlder
前插不偏移，不同于 rows.length 索引）；MessageList 计算仍位于视口底边以下的
新行数并上报，随下滚递减到 0 即消失。

回归：`scripts/verify-resticky.mjs:74-107` 共 6 个断言（初始贴底、scrollBy(-10)
打破、scrollBy(999) 落在 maxScroll、无增长帧底部重贴、notifyCount>0 订阅通知、
部分下滚不得重贴），用 handle.subscribe 模拟 Chat 的 useSyncExternalStore。

## 收缩帧残影修复

演进提交：`a56b8e8`（弃 ESC[2J+3J 改跳行 diff，"ConPTY 实测流式 40s 清屏
675 次→0"）→ `cb1a28b`（改 CSI 10000S 滚动到顶+全量重绘）→ `18680e5`（收缩帧
就地重画视口，issue #38/#39/#19）→ `287a811`（stdin-gap 空闲重锚，issue #16
#17）→ `6a89566`（inline 残影三连修合并 #59）。

当前机制（`src/ink/log-update.ts`）：

```text
内容收缩帧（thinking 折叠/工具卡卸载/流式收尾）：frame.screen.height 变小，
isShrinking + nextFitsViewport 检测（src/ink/log-update.ts:272-273）
  -> prevHadScrollback 且收缩进视口：repaintViewportInPlace 就地重建视口
     （:285-290，零滚动零 scrollback 沉积）
  -> 内容仍高于视口（每轮 turn 常见 1-2 行收缩）：cursorAtBottom 时就地重画
     （:311-337，"park 行 → 视口顶 → ED 清 → 重打帧尾窗口"）；光标不在预期处
     才回退 fullResetSequence_CAUSES_FLICKER('offscreen')
  -> 稳态帧：scrollback 行（y < viewportY）跳过 diff（:292-297 注释、
     :378-391 裁剪、:445-447 实际跳过），不再因 scrollback 行变化触发
     ESC[2J+3J 清屏（清 scrollback 会让 Windows Terminal 视口跳顶，
     claude-code #35580）
```

空闲重锚（`src/ink/log-update.ts:64-84`）：requestViewportReanchor 一次性主屏重画
（物理光标处盲重建视口），由 stdin-gap 重断言（>5s 空闲后按键）触发，修复
第三方 tty 写入污染（issue #16 #17）。

回归：`scripts/verify-shrink.mjs:103-141` 字节断言（无 CSI n S、无 ESC[2J/3J）
+ @xterm/headless 重建终端语义断言（marker 在最后内容行、旧行 40-59 零残留、
可见行连续唯一且以 39 结尾）。脚本头部 :9-14 记载演进：旧方案是 full-reset
（CSI 10000S 清屏 + 整帧重打），每次把整份 UI 复制进 scrollback（#38/#39/#19
的"上滚看到重复渲染"由此累积）。

## 空闲重锚与全屏锚定

- 每帧 CSI H 重置物理光标 + 尾部 park 补丁（iTerm2 光标引导，src/ink/ink.tsx:568-651）；
  resize 时 ERASE_SCREEN 放进 BSU/ESU 原子块防 80ms 空白。
- repaint API 三件套（src/ink/ink.tsx:812-861）：repaint() 重置双帧缓冲；forceRedraw()
  （Ctrl+L）SGR_RESET+ERASE_SCREEN+CURSOR_HOME 后全量重画；
  invalidatePrevFrame() 单次全 damage（卸载高大 overlay 防残影——blit 快路径
  会复制陈旧 cell 留下 ghost title/divider）。
- 搜索侧渲染（src/ink/ink.tsx:1083-1123）：scanElementSubtree 直接绘制主树既有 DOM
  子树到新 Screen——无第二个 React root、无 context bridge，约 1-2ms 纯绘制。

## TPS 计算

`src/channel.ts` 的 TPS 折叠链（`scripts/verify-tps.mjs` 对应机制）：

```text
turn/start（:2747-2760）：tpsTurnDecodeMs=0、DecodeTokens=0、tpsBeforeTurn=state.tps
  -> step/start（:2557-2566）：新建 tpsStep{firstTokenTime: undefined, outputChars: 0}
  -> assistant/chunk（:2568-2595）：isTokenDelta 时 firstTokenTime ??= event.time、
     outputChars += tokenDeltaChars；elapsedMs>500 时实时估算
  -> assistant/message 结算（:2632-2652）：usageOutputTokens(usage) ??
     ceil(outputChars/4)；tpsTurnDecodeMs += event.time - firstTokenTime
  -> turn/end（:2762-2782）：加权折叠 turnTps 写 state.tps 并 push
     tpsSamples({tps, at: event.time}，上限 500)；未采样回退 tpsBeforeTurn
  -> 展示：src/screens/StatusLine.tsx:57-70 tps 读数（channel.working 且无完成样本时用实时
     估算） + renderTpsGauge
```

`scripts/verify-tps.mjs:103-189` 覆盖：两步 turn 排除 51s 工具间隔按
Σtokens/ΣdecodeMs 折叠、reasoning/tool-call delta 建立首 token 边界、实时
chars/4 估算、provider usage 结算、重试式延迟留在同一步 decode 跨度、缺 usage
回退 chars/4、durable 回放由 event.time 推导同值。

## CJK 文本测量体系

### stringWidth（核心）

`src/ink/stringWidth.ts`：

- Bun 分支（:211-231）：模块作用域一次性解析 Bun.stringWidth（typeof 守卫防
  deopt，热路径约 10 万次/帧），Bun 模式传 `{ ambiguousIsNarrow: true }`。
- JS 回退（:13-19）：比 string-width 包更准确，纠正 U+26A0（警告符号）
  被误报为宽度 2；ambiguous 字符按窄（宽 1）处理（Unicode 标准对西方语境
  建议）。
- 三档路径（:20-104）：纯 ASCII 快路径（排除控制字符）；含 ESC 先 stripAnsi；
  简单 Unicode 按 code point 用 eastAsianWidth(ambiguousAsWide:false) 且跳过
  isZeroWidth；复杂串走 Intl.Segmenter 按 grapheme 处理 emoji 与合字。
- 已知分歧（:205-209，显式注释）：梵文合字 क्ष 以 ligature 渲染但占 2 终端
  格，Bun.stringWidth=2 与终端一致；JS 回退按 grapheme 计 1 会与终端失同步。

### 缓存与测量

| 组件 | 位置 | 行为 |
| --- | --- | --- |
| line-width-cache | `src/ink/line-width-cache.ts` | 按行缓存 stringWidth（流式期间已完结行不可变，每 token 减少约 50 倍调用）；有界化（OOM 修复，提交 2f60c33）：4096 条 / 10 万字符预算 / 超 500 字符的行永不缓存（流式增长尾行每帧新键零复用）/ 超预算整表清空；detachString 用 Buffer 往返复制键，避免 V8 SlicedString 钉住整条流式父串（实测 10KB 行×3000 帧驻留 1.15GB→2.3MB） |
| measure-text | `src/ink/measure-text.ts:22-45` | 单遍测量：按 '\n' 切行循环，每行 lineWidth(line) 取最大宽；noWrap 需在循环前判定（Math.ceil(w/Infinity)=0 陷阱）；非 noWrap 每行高 Math.ceil(w/maxWidth)，w===0 记 1；空串返回 0 |
| measureTextNode | `src/ink/dom.ts:447-483` | 显示宽度进入 Yoga 布局的入口：expandTabs（按最坏 8 空格）→ measureText 测宽高 → 超宽按 textWrap 用 wrapText 换行后复测；含 \n 且 Undefined 模式用 max(width, 自然宽) 防高度虚增 |
| 增量缓存 | `src/ink/dom.ts:485-546` | 同一节点同宽同 wrap 且文本前缀增长时，只对尾行 re-wrap（O(当前行) 而非 O(整文)），已完结逻辑行提交进 headHeight |

### 换行与截断

| 组件 | 位置 | 行为 |
| --- | --- | --- |
| wrap-text | `src/ink/wrap-text.ts:47-81` | 分发：'wrap' → wrapAnsi(trim:false, hard:true)、'wrap-trim' → wrapAnsi(trim:true, hard:true)、startsWith('truncate') → truncate()、其余原样返回 |
| truncate | `src/ink/wrap-text.ts:15-38` | columns<1 返回空串、columns===1 返回省略号；start 位 → ELLIPSIS+sliceFit 尾段；middle 位 → 前后 sliceFit 夹 ELLIPSIS；默认 end 位 → sliceFit 头段+ELLIPSIS |
| sliceFit | `src/ink/wrap-text.ts:8-13` | sliceAnsi 可能把 end-1 处宽度 2 的 CJK 整字带入导致超 1 列，用 stringWidth 复核后收紧一列重试一次 |
| wrapAnsi 双后端 | `src/ink/wrapAnsi.ts:9-28` | Bun.wrapAnsi 可用则用之，否则回退 npm wrap-ansi 包 |
| sliceAnsi | `src/utils/sliceAnsi.ts:35-89` | 按显示单元格而非 code unit 前进：ansi/control 计 0、fullWidth 计 2、否则 stringWidth(token.value)；尾部零宽符号归属前一个基字符、起始边界零宽符号跳过 |
| truncateToWidth | `src/ink/truncateToWidth.ts:8-18` | 共享截断 helper（提交 0530a99）：for...of 按 code point 迭代，每字符 stringWidth 累计单元格，超限即 break，绝不劈开宽字符；前置约束输入无 ANSI（:3-7 注释 "callers pass plain text"） |

**truncateToWidth 三个调用点**（ci.yml:69 注释称"4 处描述按终端显示宽度处理"，
可枚举截断点实为 3 处，见下节冲突）：

| 调用点 | 位置 | 行为 |
| --- | --- | --- |
| FileSuggestions（@ 文件建议） | `src/components/FileSuggestions.tsx:38-49` | descriptionWidth = Math.max(0, columns - 24)；description 仅为 'directory'/'file' 字面量；文件名列按显示宽度 padding（`' '.repeat(Math.max(1, 20 - stringWidth(name)))`，:46） |
| CommandSuggestions（/ 命令建议） | `src/components/CommandSuggestions.tsx:26-58` | descriptionWidth = Math.max(0, columns - nameWidth - tagWidth - 4)，nameWidth 上限为终端宽 40% |
| MessageList compactPreview | `src/components/MessageList.tsx:565-571` | 默认 limit=60 个终端单元格，超限时 truncateToWidth(flat, limit-1) + '…'，注释明示 CJK 宽字符算双列且不劈字 |

修复历史：0530a99（新增 truncateToWidth；修 FileSuggestions issue #34、
MessageList compactPreview——"60 字符的 CJK 摘要实际占 120 列必换行"；有意不动
CommandSuggestions 避免与 PR #45 冲突）→ 0f18eb5（PR #45 已被作者关闭，同款
bug 在 CommandSuggestions 仍未修，改挂共享 helper）→ 74c307e（补挂
verify-cjk-truncate 到 CI，issue #41）。

回归：`scripts/verify-cjk-truncate.tsx` 单元断言（纯 CJK limit∈
{0,1,2,3,4,5,7,8} 截断后 stringWidth ≤ limit；limit=3 只留 '你'；中英混排
'ab中cd' 截 4 列 = 'ab中'；宽字符卡边界 'a中b' 截 2 列 = 'a'）+
@xterm/headless COLS=28 窄终端渲染 FileSuggestions 断言每行 stringWidth ≤ 28
且出现省略号。

### 渲染期换行判定

`src/ink/render-node-to-output.ts:604-626`：`maxWidth = Math.min(getMaxWidth(yogaNode),
output.width - x)`（注释：上游 Ink 用未钳制 getMaxWidth 会丢屏外字符），
`widestLine(plainText) > maxWidth` 判需换行；wrapWithSoftWrap 按输入行逐个 wrap
并标注 soft-wrap 续行（:362-394，truncate 模式不产生新行故 softWrap 为
undefined）。

`output.ts` 写屏裁剪：垂直 clip 用 `widestLine(text)` 判整块（:533）；水平 clip
`stringWidth(line)` 定 to、sliceAnsi 切、宽字符跨界超 1 列则收紧一列重试
（:548-564）；flushBuffer 按 grapheme 段 stringWidth 得每格宽（:729-736）；
softWrap 的 contentEnd 来自 writeLineToScreen 的 tab 展开感知值，而
`x+stringWidth(line)` 把 tab 当宽 0（:596-619）。

其他显示宽度使用点：MarkdownTable（src/components/MarkdownTable.tsx）列宽/对齐/
padAligned、src/ink/render-border.ts:45 边框文本宽、src/components/design-system/Divider.tsx:56 标题宽、
shimmer/Spinner 段宽、src/components/messages/MessageMetadata.tsx:31、
src/components/messages/AssistantToolUseMessage.tsx:235、src/ink/tabstops.ts:46 expandTabs 列推进。

## 冲突

| 项 | 两侧 |
| --- | --- |
| CI 挂载缺口 | 四个渲染验证脚本（verify-resticky/verify-scroll/verify-shrink/verify-tps）均未挂入 CI（ci.yml 27-71 行 12 个回归步无这四个）；113ff7d 提交声称的 "verify-resticky 6/6、verify-scroll 6/6" 属手动验证；docs/contributing.md:129-136 称 CI 仅跑 3 个命令与实况不符 |
| renderToScreen 死代码 | `src/ink/render-to-screen.ts` 导出 renderToScreen（自建 LegacyRoot + updateContainerSync，注释称 "Used for search: render ONE message"），但 src/ 内无任何调用者；实际搜索路径是 src/ink/ink.tsx:1093-1123 scanElementSubtree（直接绘制主树既有 DOM 子树）——renderToScreen 是被取代方案的残留（仅 lib 产物保留导出） |
| verify-shrink 表述层次 | 脚本头部称旧方案为 "full-reset（CSI 10000S 清屏+整帧重打）"，提交史显示更早还有 ESC[2J+3J 阶段（a56b8e8）——脚本只描述最近旧方案 |
| "4 处描述"口径 | `.github/workflows/ci.yml:68-70` 注释称 "4 处描述按终端显示宽度处理"，可枚举截断调用点只有 3 处（src/components/FileSuggestions.tsx:48、src/components/CommandSuggestions.tsx:57、src/components/MessageList.tsx:570） |
| textWrap 'end'/'middle' no-op | src/ink/styles.ts:68-69 类型联合声明 textWrap: 'end'\|'middle'，src/ink/components/Text.tsx:73-84 也映射，但 src/ink/wrap-text.ts:66-80 分发不处理这两个值——类型有效而行为为 no-op（'truncate-end' 经 startsWith('truncate') 生效） |
| cli-truncate 注释转述 | src/ink/render-node-to-output.ts:368 注释称 truncate 模式 "cli-truncate is whole-string"，本仓库并无 cli-truncate 依赖，truncate 由本地 sliceFit/sliceAnsi 实现——注释是上游 provenance 转述，行为上成立 |

## 未验证事项

- renderToScreen 是否仍被 lib/ 外部消费者使用（package.json exports 不含该
  路径，但无法排除外部深路径 import）。
- 真实 ConPTY 下的实际 React commit 频率与 16ms 节流命中率（commit 间隔统计
  仅在 CLAUDE_CODE_COMMIT_LOG 开启时输出，src/ink/reconciler.ts:279-304）。
- DEFAULT_HEADER_LINES=14 冷启动估计首测校正后的具体值、5000 条 FIFO 高度缓存
  在超长会话深滚时的估计偏差（需运行 TUI 实测）。
- Bun 与 Node 对梵文 grapheme 宽度判定不一致在非 Bun 运行时的实际布局失同步
  程度（src/ink/stringWidth.ts:205-209 注释承认分歧，无 Node 端补偿验证）。
- sliceAnsi 对 position 起点落在宽字符第二格的行为无单测覆盖。
- verify-cjk-truncate.tsx 等脚本在当前环境实际通过与否未验证（只读审计禁止
  安装依赖/运行脚本，断言逻辑与代码逐条比对一致）。

相关文档：[ink-core.md](ink-core.md)（渲染内核结构）、
[input-commands.md](input-commands.md)（输入与滚动键位）、
[unknowns.md](unknowns.md)（未验证清单）。
