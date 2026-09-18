/**
 * verify-selection-stale-guard — 选区提交一致性守卫回归（refreshSelectionFingerprint）。
 *
 * copy-on-select 从屏幕 cell 缓冲提取文本；当转录在高亮下原地替换行内容
 * （流式输出改写折叠行，视口无滚动 → 无 follow-shift 协调）时，高亮坐标
 * 读到的是替换后的另一段文本——用户贴出的「复制出乱码实为另一行内容」。
 * 守卫对选区覆盖行逐帧做指纹：未协调变化 → stale 锁存 → copySelectionNoClear
 * 拒绝（返回空并清选区），useCopyOnSelect 经 onRefused 提示。
 *
 * 覆盖：
 *   A. 首帧建立基线（不判 stale）；
 *   B. 覆盖行内容未协调替换 → stale=true（一次、幂等）；
 *   C. coordinated 帧（follow/resize 平移后的合法滚动）内容变化 → 不 stale；
 *   D. 选区外的行替换 → 不 stale；
 *   E. noSelect/spacer cell 不参与指纹（其内容变化不改指纹）；
 *   F. startSelection/clearSelection 重置指纹与 stale；
 *   G. stale 拒绝后 getSelectedText 仍可读（守卫在提交层，不在读取层）；
 *   H. 几何变化（拖选 motion/键盘平移/多击）自动重基线，不判 stale；
 *   I. 列区间与 getSelectedText 一致：选区列之外的流式追加不误伤；
 *   J. softWrap 位翻转（复制结果从两行变拼接）在 cell 不变时也锁存。
 *
 * 运行：node --import tsx/esm scripts/verify-selection-stale-guard.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

const { refreshSelectionFingerprint, startSelection, updateSelection, clearSelection, selectionBounds } =
  await import('../src/ink/selection.js')
import type { Screen, SelectionState } from '../src/ink/screen.js'
import type { SelectionState as SelState } from '../src/ink/selection.js'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** 最小 Screen：refreshSelectionFingerprint 只读 cells/noSelect/width/height。 */
function makeScreen(rows: number, cols: number): Screen {
  return {
    width: cols,
    height: rows,
    cells: new Int32Array(rows * cols * 2),
    noSelect: new Uint8Array(rows * cols),
    softWrap: new Int32Array(rows),
  } as unknown as Screen
}

/** Fresh selection state（生产构造走 createSelectionState，此处等价字面量）。 */
function makeSel(): SelState {
  return {
    anchor: null, focus: null, isDragging: false, anchorSpan: null,
    scrolledOffAbove: [], scrolledOffBelow: [], scrolledOffAboveSW: [], scrolledOffBelowSW: [],
    lastPressHadAlt: false, coveredFingerprint: null, coveredGeometry: null, stale: false,
  } as unknown as SelState
}

/** 写一个窄字符（word0=charId 非零，word1 width=Narrow=0）。 */
function putNarrow(s: Screen, col: number, row: number, charId: number): void {
  const ci = (row * s.width + col) * 2
  s.cells[ci] = charId
  s.cells[ci + 1] = 0
}

// ── A. 首帧基线 ──────────────────────────────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 3)
  putNarrow(screen, 0, 1, 100)
  putNarrow(screen, 0, 2, 101)
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('A. first frame establishes baseline without verdict',
    !changed && sel.coveredFingerprint !== null && !sel.stale)
}

// ── B. 未协调替换 → stale ────────────────────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  putNarrow(screen, 0, 1, 200)
  refreshSelectionFingerprint(sel, screen, false)
  // 行内容被另一段文本替换（不同 charId 序列）
  putNarrow(screen, 0, 1, 999)
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('B. uncoordinated replacement latches stale', changed && sel.stale)
  // 幂等：已锁存后不再重复报告
  const again = refreshSelectionFingerprint(sel, screen, false)
  check('B2. latched stale is idempotent', !again && sel.stale)
}

// ── C. coordinated 帧的内容变化不判 stale ────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  putNarrow(screen, 0, 1, 300)
  refreshSelectionFingerprint(sel, screen, false)
  // follow-shift 帧行内容平移（新行进入选区）
  putNarrow(screen, 0, 1, 301)
  putNarrow(screen, 1, 1, 302)
  const changed = refreshSelectionFingerprint(sel, screen, true)
  check('C. coordinated scroll change does not latch stale',
    !changed && !sel.stale && sel.coveredFingerprint !== null)
}

// ── D. 选区外的行替换不判 stale ──────────────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  putNarrow(screen, 0, 1, 400)
  refreshSelectionFingerprint(sel, screen, false)
  // 选区外的第 3 行整行替换（流式新输出落在选区之外）
  for (let c = 0; c < 10; c++) putNarrow(screen, c, 3, 500 + c)
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('D. out-of-selection replacement does not latch stale', !changed && !sel.stale)
}

// ── E. 被 noSelect/spacer 跳过的 cell 内容变化不影响指纹 ────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  putNarrow(screen, 0, 1, 600)
  // 第 5 格是 noSelect（gutter 类），第 6 格是 spacer tail：getSelectedText
  // 跳过它们输出，指纹同样跳过——它们的内容变化对两者都不可见。
  screen.noSelect[1 * 10 + 5] = 1
  screen.cells[(1 * 10 + 6) * 2 + 1] = 2
  refreshSelectionFingerprint(sel, screen, false)
  // 改这两个被跳过格的内容（只动 word0=charId；putNarrow 会把 spacer
  // 的 width 位重置为 Narrow，那就不再是被跳过的格了）
  screen.cells[(1 * 10 + 5) * 2] = 601
  screen.cells[(1 * 10 + 6) * 2] = 602
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('E. skipped-cell (noSelect/spacer) content changes do not latch stale',
    !changed && !sel.stale)
}

// ── F. start/clear 重置 ──────────────────────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  putNarrow(screen, 0, 1, 700)
  refreshSelectionFingerprint(sel, screen, false)
  putNarrow(screen, 0, 1, 701)
  refreshSelectionFingerprint(sel, screen, false)
  if (!sel.stale) check('F. precondition: stale latched', false)
  clearSelection(sel)
  check('F. clearSelection resets fingerprint and stale',
    sel.coveredFingerprint === null && sel.coveredGeometry === null && !sel.stale)
  // A fresh startSelection must also reset both fields — not just rely on
  // clearSelection having run first (CodeRabbit: the assertion would keep
  // passing if startSelection silently stopped resetting). Re-latch stale
  // on a rebuilt selection, then startSelection over it.
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  refreshSelectionFingerprint(sel, screen, false)
  putNarrow(screen, 0, 1, 703)
  refreshSelectionFingerprint(sel, screen, false)
  if (!sel.stale) check('F. precondition 2: stale re-latched', false)
  startSelection(sel, 0, 2)
  updateSelection(sel, 9, 2)
  check('F2. startSelection resets fingerprint and stale',
    sel.coveredFingerprint === null && sel.coveredGeometry === null && !sel.stale)
}

// ── G. stale 是提交层守卫，不改变读取层 ─────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  putNarrow(screen, 0, 1, 800)
  refreshSelectionFingerprint(sel, screen, false)
  putNarrow(screen, 0, 1, 801)
  refreshSelectionFingerprint(sel, screen, false)
  // selectionBounds（读取层）在 stale 下仍可读出同一几何——守卫只在
  // copySelectionNoClear 的提交路径拦截（CodeRabbit: 直接调用要验证的
  // API，而不是只看字段）。
  const b = selectionBounds(sel)
  check('G. stale guards commit, not bounds reading',
    sel.stale && b !== null && b.start.row === 1 && b.end.row === 1
    && b.start.col === 0 && b.end.col === 9)
}

// ── H. 几何变化（拖选 motion）自动重基线 ─────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 4, 1)
  putNarrow(screen, 0, 1, 900)
  refreshSelectionFingerprint(sel, screen, false)
  // 拖选延伸到下一行（几何变化）+ 新行内容——不判 stale
  updateSelection(sel, 9, 2)
  putNarrow(screen, 0, 2, 901)
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('H. geometry change (drag extension) re-baselines, no stale',
    !changed && !sel.stale)
  // 几何稳定后再原地替换 → 恢复正常守卫
  putNarrow(screen, 0, 2, 999)
  const relapse = refreshSelectionFingerprint(sel, screen, false)
  check('H2. guard re-arms after re-baseline', relapse && sel.stale)
}

// ── J. softWrap 翻转改变复制结果 → 指纹必须感知 ─────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 2)
  putNarrow(screen, 0, 1, 1010)
  putNarrow(screen, 0, 2, 1011)
  refreshSelectionFingerprint(sel, screen, false)
  // Same cells, but row 2 becomes a soft-wrap continuation of row 1: the
  // copy changes from "two lines" to "one joined line" — a stale copy
  // passing through would ship the OLD joining. The fingerprint must see
  // the flip even though no cell content changed.
  screen.softWrap[2] = 7
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('J. soft-wrap flip latches stale with unchanged cells', changed && sel.stale)
}

// ── I. 列区间与 getSelectedText 一致 ─────────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 3, 1)
  for (let c = 0; c <= 3; c++) putNarrow(screen, c, 1, 100 + c)
  refreshSelectionFingerprint(sel, screen, false)
  // 选区列之外的流式追加（列 5-9 持续输出）——复制不读这些列，不误伤
  for (let c = 5; c < 10; c++) putNarrow(screen, c, 1, 200 + c)
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('I. streaming append outside the selected columns does not latch stale',
    !changed && !sel.stale)
  // 选区内列被替换 → 正常锁存
  putNarrow(screen, 1, 1, 999)
  const inside = refreshSelectionFingerprint(sel, screen, false)
  check('I2. replacement inside the selected columns still latches', inside && sel.stale)
}

console.log(failures === 0 ? 'selection stale-guard regression passed' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
