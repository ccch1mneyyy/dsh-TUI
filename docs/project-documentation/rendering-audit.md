# dsh-TUI 渲染错位与重复渲染审计报告

> 交接文档：供后续 AI 实施修复使用。
>
> 本次审计并行使用 6 路 v4f 子代理，覆盖 Ink 渲染生命周期、终端差分、PromptInput、MessageList、浮层、流式 channel 和现有回归脚本。
>
> **状态**：本报告只记录源码审计证据和修复边界。本轮没有修改 `src/`，也没有将未执行的构建或脚本写成通过。

## 1. 执行摘要

用户症状包括：

- 输入框内容出现在正文区域；
- 正文覆盖输入框或输入框边框；
- 正文、启动画或工具输出重复出现；
- 滚动、收缩、切换浮层后出现错位或空洞。

当前证据更支持“终端物理帧、布局缓存和增量差分失配”，而不是 React 把同一条消息重复挂载。普通 assistant chunk/message 已有 seq、step、重叠合并和稳定 `row.id` 防护，未发现正常事件流会确定性地把同一正文追加两次。

优先级：

1. **P0**：inline 主屏相对光标被外部 TTY 写入扰乱。
2. **P1**：PromptInput 高度收缩、Unicode caret 几何不一致。
3. **P1**：MessageList 行高缓存过期导致虚拟 spacer 错位。
4. **P1/P2**：小终端 absolute overlay 覆盖 composer/status。
5. **P2**：resize generation、detached Ink 实例和测试门禁补强。

## 2. P0：inline 主屏相对光标漂移

### 证据

- [`src/ink/log-update.ts`](../../src/ink/log-update.ts#L75)
- [`src/ink/log-update.ts`](../../src/ink/log-update.ts#L280)
- [`src/ink/ink.tsx`](../../src/ink/ink.tsx#L777)
- [`src/dsh-adapter/childStderr.ts`](../../src/dsh-adapter/childStderr.ts#L4)
- [`scripts/repro-inline-thirdparty.tsx`](../../scripts/repro-inline-thirdparty.tsx#L108)

### 根因与时序

inline/main-screen 模式无法绝对定位到 scrollback 中的任意行，只能假设物理光标仍在上一帧记录的 `prev.cursor`。

如果 child process、native logger 或其他代码直接向 TTY 写入：

```text
\r\nError...\r\nUsage...\r\n
```

物理光标会移动并可能滚屏，但 `frontFrame.cursor` 和 `LogUpdate` 内部状态不会变化。下一帧的相对 `cursorMove`、擦除和正文 patch 仍从旧坐标计算，于是可能出现：

- 正文 patch 写到输入框行；
- 输入框 patch 写到正文尾部；
- 全部内容整体上移或下移；
- 后续帧继续叠加残影，直到 reanchor 或 full repaint。

现有 `reassertTerminalModes()` 只能事后恢复；child stderr guard 主要覆盖经过 patched CJS `spawn` 的路径，ESM 快照、native writer 或直接 fd 写入仍需审查。

### 修复要求

1. 所有 child stderr/stdout/native logger 禁止直接写 TTY，改为 pipe 或统一通知 sink。
2. 所有 raw terminal writer 与 Ink frame writer 进入同一串行队列，避免帧间交错。
3. raw write 发生后清空 `displayCursor`，请求一次 viewport reanchor，再恢复相对 diff。
4. 保留 stdin-gap reanchor 作为兜底。
5. **不要**把 declared cursor 的 full-frame `target.y` 改成 viewport-local 坐标；`ink.tsx` 现有注释明确说明那会让光标逐帧上移并覆盖正文。

## 3. P1：PromptInput 高度收缩

### 证据

- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L61)
- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L936)
- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L1018)
- [`src/components/EffortInputBorder.tsx`](../../src/components/EffortInputBorder.tsx#L120)
- [`src/ink/render-node-to-output.ts`](../../src/ink/render-node-to-output.ts#L540)

### 根因

`MAX_VISIBLE_LINES = 5` 只限制 `visibleLines` 数组长度，没有给内容区域设置固定高度。实际结构是：

```text
顶边框 1 行
输入内容 intrinsic height
底边框 1 行
```

因此 PromptInput 会在短文本和多行文本之间改变高度；Enter、Esc、Ctrl+C 或 Backspace 清空时，composer 会在同一时序中收缩，连带改变：

- 底部 chrome 高度；
- ScrollBox viewport 高度；
- 正文尾部 y 坐标；
- absolute overlay 锚点；
- 旧输入区域与下移 sibling 的 clear/blit 范围。

### 修复方案

先用专门 repro 验证，再选择其中一种：

**方案 A：固定内容区高度，最稳妥**

```tsx
<Box height={MAX_VISIBLE_LINES} flexShrink={0} overflow="hidden">
  {rendered}
</Box>
```

空余行填空白，使总高度恒为顶边框 1 + 内容 5 + 底边框 1。代价是 composer 常驻占用更多屏幕行。

**方案 B：保持紧凑 UI，收缩时强制完整恢复**

保留自然增高，但在输入高度缩小时：

- 设置 `prevFrameContaminated = true`；
- 强制完整 damage；
- 主屏调用 `reanchorViewport()`；
- 确保旧 composer rect 以及所有下移 sibling 在同一帧清理。

不能只依赖单个节点 `positionChanged` 清理，因为正文、浮层和输入框可能同时改变。

## 4. P1：PromptInput Unicode/caret 几何

### 证据

- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L788)
- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L809)
- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L936)
- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L973)
- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L1160)
- [`src/utils/intl.ts`](../../src/utils/intl.ts#L8)

### 根因

当前逻辑混用三套单位：

- 左右键、Backspace、Delete：UTF-16 code unit；
- `wrapToWidth()`：Unicode code point；
- `stringWidth()`：grapheme/display cell。

在 `a😀b`、ZWJ emoji 或组合字符中，左右移动可能把 cursor 放到 surrogate/组合簇中间，删除可能只删半个字符，`line.slice()` 也可能把 caret 切进 grapheme。最终表现为文本断行、反色 caret 和硬件 cursor 不同列。

### 修复要求

使用现有 `getGraphemeSegmenter()` 统一实现：

- `normalizeCursorOffset(text, offset)`；
- grapheme-aware 左右移动；
- Backspace/Delete 删除完整 grapheme；
- wrap 只在 grapheme 边界换行；
- caret 的 `before / at / after` 使用完整 grapheme；
- 极窄终端输入宽度至少使用真实可用宽度的 `Math.max(1, ...)`，不要固定 10；
- declared cursor column 最终 clamp 到 value box 实际宽度。

## 5. P1：MessageList stale height cache

### 证据

- [`src/components/MessageList.tsx`](../../src/components/MessageList.tsx#L178)
- [`src/components/MessageList.tsx`](../../src/components/MessageList.tsx#L194)
- [`src/components/MessageList.tsx`](../../src/components/MessageList.tsx#L209)
- [`src/components/MessageList.tsx`](../../src/components/MessageList.tsx#L326)

### 根因

`heightsRef` 只在 terminal columns 变化时清空，但以下状态同样会改变行高：

- Ctrl+O 全局展开/折叠；
- 单行展开；
- reasoning streaming → folded；
- tool result/error/footnote 出现；
- diff layout 改变；
- assistant 文本增长或替换；
- loaded context 展开/折叠。

旧 offsets 会继续用于 `topPad`、`bottomPad`、窗口 `start/end` 和 ScrollBox clamp。变化行若已离开 mounted window，无法及时重新测量，可能出现 blank band、重叠或错误 scrollTop。

### 修复建议

为每个 row 保存 layout signature，至少包含：

```text
columns
row.kind
row.text
row.streaming
expanded
expandedRows.has(row.id)
thinkingVisible
thinkingFold
tool status/result/error
 diffLayout
toolFootnote
```

signature 变化时删除该行 height。若变化行不在当前 mounted window，暂时扩大 mounted window 或禁用 aggressive virtualization，待 `useLayoutEffect` 测量完成后恢复。

不要改成 index key；继续使用 `key={row.id}`。

## 6. P1/P2：小终端 absolute overlay

### 证据

- [`src/screens/Chat.tsx`](../../src/screens/Chat.tsx#L2331)
- [`src/components/PromptInput.tsx`](../../src/components/PromptInput.tsx#L1016)
- [`src/components/OverlayAbove.tsx`](../../src/components/OverlayAbove.tsx#L22)
- [`src/ink/render-node-to-output.ts`](../../src/ink/render-node-to-output.ts#L500)

### 根因

当前浮层最小高度分别是：

```tsx
Math.max(terminalRows - 8, 8)
Math.max(terminalRows - 6, 4)
```

在 4-7 行终端中，浮层可能大于可用屏幕；renderer 又把 absolute 节点的负 y 直接钳到 0，破坏 `bottom="100%"` 锚定语义，导致浮层覆盖正文尾部、composer 或 status。

### 修复建议

- maxHeight 由实际 anchor 可用高度计算；
- 极小终端允许高度为 0/1，不使用硬编码 8/4 最小值；
- 使用一致的 clip，不能只钳负 y；
- 关闭浮层时恢复被覆盖的底层 cells；
- 扩展 rows=4、5、6、7 的 help/command/file/model picker 回归。

## 7. P2：resize 与生命周期补强

### Resize

建议修改：

- [`src/ink/ink.tsx`](../../src/ink/ink.tsx#L346)：resize 后失效旧 `renderGeneration`、`pendingRenderGeneration` 和 `drainTimer`；
- [`src/ink/ink.tsx`](../../src/ink/ink.tsx#L542)：`onRender()` 使用 `this.terminalColumns/terminalRows`，不要混用 live stdout 尺寸；
- 若检测到 live 尺寸与缓存不一致，先走 resize 同步路径，不直接画帧。

### Detached instance

`detachForShutdown()` 设置 `isUnmounted` 后，后续 `unmount()` 会短路，可能留下 `instances` 映射。建议在 [`src/ink/ink.tsx`](../../src/ink/ink.tsx#L1130) 加入：

```ts
instances.delete(this.options.stdout)
```

### renderToScreen

[`src/ink/render-to-screen.ts`](../../src/ink/render-to-screen.ts#L34) 使用模块级共享 root/container/output，嵌套调用时可能串树。当前未确认是 Chat 的直接触发点，列为后续低优先级非重入 guard，不要与 P0/P1 修复混杂。

## 8. 不要回退的现有防护

- `log-update.ts` 的 anchored shrink repaint；
- 非滚动重画使用 `CR + CUD`，不要改回底行 LF；
- alt-screen 的 rows×cols blank frame invariant；
- absolute node removal 后禁用 blit；
- `MessageList` 的稳定 `key={row.id}`；
- channel 的 chunk/message seq 与 overlap 去重。

## 9. 推荐实现顺序

1. 封锁/串行化绕过 writer 的 TTY 输出，保留 reanchor 兜底。
2. 修 PromptInput 高度收缩和 grapheme-aware caret/edit。
3. 修 MessageList layout signature 与 stale height recovery。
4. 修小终端 overlay 的可用高度和关闭恢复。
5. 补 resize generation、detached instance 和非重入 guard。
6. 将高价值渲染脚本纳入可失败的门禁。

## 10. 验证矩阵

修改后依次运行：

```powershell
pnpm run build
node --import tsx/esm scripts/repro-inline-thirdparty.tsx
node --import tsx/esm scripts/repro-inline-scrollback.tsx
node --import tsx/esm scripts/repro-model-switch-scrollback.tsx
node scripts/verify-shrink.mjs
node scripts/verify-scroll.mjs
node --import tsx/esm scripts/verify-ime-cursor.tsx
node --import tsx/esm scripts/verify-message-measure-depth.tsx
node --import tsx/esm scripts/verify-jediterm.tsx
```

验收标准：

- inline scrollback 中每个唯一 marker 只出现一份；
- 不出现不必要的 `CSI 10000S`、整屏 `CSI 2J/3J` 或重复 shrink frame；
- 正文、thinking、tool、输入框和边框始终占不同物理行；
- PromptInput 反色 caret 与 xterm hardware cursor 坐标一致；
- emoji/ZWJ/组合字符不被拆开；
- overlay 开关后底层 cells 与 fresh render 一致；
- sticky/non-sticky 滚动过程中无连续空洞、重叠或 marker 乱序；
- 增量流式终态与全新挂载终态逐行等价。

## 11. 交接注意事项

负责修改的 AI 应先读取本报告和 [`AGENTS.md`](../../AGENTS.md)，确认 Git 工作区状态，再按功能拆分修改和验证。不要根据本报告把未运行的脚本标记为 PASS；每组修复都应保留实际 diff 和命令输出。

## 12. 修复记录（2026-08-22，commit 41f9e9b）

按第 9 节顺序实施，第 1-5 组全部落地；第 6 组（脚本纳入 CI 门禁）未做。

**已修复（4 文件，+292/-35）**：

- `src/ink/ink.tsx`：
  - §7 resize：`onRender()` 改用缓存 `terminalColumns/terminalRows`（与 `onComputeLayout` 的布局尺寸一致）；live 尺寸漂移时先走 `handleResize()` 同步路径并跳过本帧。`handleResize()` 现在失效 `renderGeneration`/`pendingRenderGeneration`/throttle/drainTimer。
  - §2 P0：`patchStderr` 主屏分支补 `requestViewportReanchor()` + 重画兜底（每写一次、幂等、O(viewport)）；stdin-gap reanchor 保持不变。
  - §7 detached instance：`detachForShutdown()` 补 `instances.delete()`。
- `src/ink/render-node-to-output.ts`：§6 移除 absolute 节点负 y 钳 0，保留 `bottom:'100%'` 锚定 + 顶部自然 clip（`setCellAt`/`blitRegion`/`markNoSelectRegion` 均已按屏幕空间钳制，行为一致）。
- `src/components/PromptInput.tsx`：§3 收缩时 `invalidatePrevFrame()` + `reanchorViewport()`（方案 B，保持紧凑 UI）；§4 grapheme-aware 边界（移动/删除/归一化/整簇反色/断行，`Intl.Segmenter` via `getGraphemeSegmenter()`）；`inputWidth = Math.max(1, columns-3)`；declared column clamp；§6 浮层最小高度 4→1。
- `src/components/MessageList.tsx`：§5 行级 layout signature（columns/kind/text 长度/streaming/expanded/expandedRows/thinkingVisible/thinkingFold/diffLayout/model/tool status+result/error 长度/footnote）失效缓存行高；失效行强制回挂重测（sticky 侧 + 尾侧窗口扩展，非 sticky 也生效）。`key={row.id}` 未动。
- `src/screens/Chat.tsx`（两处，因并行 WIP 无法单独提交，随 picker 功能落地）：§6 `Math.max(terminalRows - 8, 8)` → `Math.max(terminalRows - 8, 1)`；`channel.workspaceCommands?.()` 防御调用（其 WIP 新代码要求该方法，缺省会抛错导致整树 unmount——所有 Chat 渲染脚本因此挂掉，已实测定位）。

**§8 的现有防护全部保留**（anchored shrink repaint、CR+CUD、alt-screen blank invariant、absolute removal blit 禁用、`key={row.id}`、channel seq/overlap）。

**验证（实际运行）**：typecheck ✅；`pnpm run build`（16 项 verify:build 门禁）✅；repro-inline-thirdparty / repro-inline-scrollback / repro-model-switch-scrollback / verify-shrink / verify-scroll / verify-ime-cursor / verify-message-measure-depth / verify-resize-reflow / verify-word-jump / verify-batched-prompt-input / verify-prompt-history-draft / verify-help-scroll 全部 PASS；verify-trace-scene 复跑全过（首跑命中 AGENTS.md 记录的 1/3 时序 flake）。

**已知未修**：verify-jediterm 4 项失败在 HEAD（bdff0af，无本次改动）上原样复现，属既有/环境问题，另行排查；§7 renderToScreen 非重入 guard 按报告标注保持低优先级未动。

## 13. 复审补充（2026-08-22，commit 1cf863e）

复审 41f9e9b 修正两个次生问题（MessageList.tsx）：

- 窗口扩展的判据从「无缓存高度」改为「曾挂载过（paintedOnceRef）且高度刚被失效」：原判据把从未测量的流式新行也当失效行，非 sticky（用户上翻）+ 流式时每帧全量挂载，虚拟化失效。
- signature 的 model 字段改为仅 expanded 时纳入：idle 切模型不再全量失效重挂。

新增 `scripts/repro-composer-ghost.tsx`（随 1cf863e 入库）：针对用户报告的「上翻 scrollback 看到输入框残影 / 上方内容不刷新」，三场景（多轮流式收缩、终端原生上翻+流式、多行草稿输入+收缩）在 xterm 缓冲区逐行扫描，断言 scrollback 零 composer 边框残影、每条内容恰一份。当前实现全部通过。

**用户症状的机制注解**：终端 scrollback 不可变；inline diff 引擎按设计跳过已进 scrollback 的行（重写需 full reset，闪屏且抹历史）。因此任何一帧把内容画错位置，错误即被冻结成"上翻看到的残影/停格"。41f9e9b 前的构建里，composer 高度收缩帧（Enter/Esc 清空多行输入）+ 第三方写入的光标漂移是两大来源。**注意 Junction 轨需重启 dsh-tui 才加载新 lib/**——旧会话中已冻进 scrollback 的残影不会消失，新会话起才用修复后的渲染。

## 14. 开放 bug：working 轮次中的底部漂移（statusline 下积空行）

**发现方式**：`scripts/verify-frame-invariants.tsx`（三层真相一致性验证器）——对同一最终状态，"长串增量帧渲染的终端"必须与"全新挂载的终端"逐行一致。该不变量当前在流式剧本后失败：**增量实例整体上浮 3 行，statusline 下积 3 行空白**（fresh 只有 1 行 cursor park 行）。Ctrl+O 展开后反而一致（B 过），Help 开关一致（C 的失败是 A 漂移的连带）。

**定位结论**（`scripts/repro-bottom-drift.tsx` 三阶段隔离）：

- 基线：statusline 下 1 空行（park 行）✓；
- 阶段 1（`working=false` 纯 assistant 流式 30 行）：仍 1 行 ✓ **干净**；
- 阶段 2（`working=true` 挂 spinner/hint 行 + 流式 + settle 收缩）：跳到 4 行（+3）；
- 阶段 3（同阶段 2 模式再来一轮）：**不再增长**（仍 4）——漂移不是逐帧累积，而是特定批次形状下的一次性错账（throttle 合并 Q2+spinner+首块流式的 frame#0 附近），时序竞态类。

**字节级证据**（xterm 逐帧 buffer 增量）：working 流式帧尾 `…statusline[CR][LF]hint"esc 中断"[CR][LF][2C][CUU4][ESU]`——帧在 park LF 之外多一次 LF；另有 spinner tick 帧 `[CUD4][CR][CUU7]✻[CR][LF×7][2C][CUU4]`。嫌疑区：log-update 尾部 cursor-restore 的 LF 记账与 ink.tsx declared-cursor 前奏（`[CUD4]` 回位）在"最后一行是 working hint 行"的帧型下错位，多余 LF 打在底缘 margin 上各滚一行。

**A/B 确认**：该漂移在 bdff0af（41f9e9b 之前）原样存在，**先于本次全部修复，非回归**。用户可见症状：长会话中 statusline/输入框整体比应有位置高、底部有空白条带（与"输入框在上面"的报告吻合）。

**后续建议**：从 repro-bottom-drift 的 frame#0（797B, LF×6, buffer+5）入手，对照 renderer 给出的 frame.cursor.y 与 log-update 实发 LF 数；修好后 verify-frame-invariants 的 A/C 应转绿，届时可将其纳入 CI 门禁。