/**
 * verify-selection-stale-guard — 选区提交一致性守卫回归（refreshSelectionFingerprint）。
 *
 * copy-on-select 从屏幕 cell 缓冲提取文本；当转录在高亮下原地替换行内容
 * （流式输出改写折叠行，视口无滚动 → 无 follow-shift 协调）时，高亮坐标
 * 读到的是替换后的另一段文本——用户贴出的「复制出乱码实为另一行内容」。
 * 守卫对选区覆盖行逐帧做指纹：未协调变化 → stale 锁存 → copySelectionNoClear
 * 拒绝（返回空并清选区），useCopyOnSelect 经 onRefused 提示。
 *
 * 指纹的「身份」是单元格的**文本内容**（charPool.get(charId)），不是池内数字
 * ID：charId 是代际 CharPool 的下标，Ink.resetPools()（ink.tsx）每 ~5 分钟
 * 换一个新池并 migrateScreenPools 重新 intern 整个 front frame，同一段文字会
 * 拿到不同的号——按 ID 哈希就会把「池重建」误判成「内容被替换」，拒绝一次
 * 本来完全合法的复制。K 组正是钉这条。
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
 *   J. softWrap 位翻转（复制结果从两行变拼接）在 cell 不变时也锁存；
 *   K. 代际池重建（charPool 换新 + migrateScreenPools，即 Ink.resetPools）
 *      且文本不变 → 不锁存，真实 Ink.copySelectionNoClear() 仍复制出原文；
 *   K2. 同一颗树上真实替换文本 → 仍然拒绝（守卫没被改钝）；
 *   L. 选区**下一行**的 softWrap 位也是复制结果的输入（extractRowText 用它当
 *      本行 contentEnd）：只翻它 → 复制变了 → 守卫必须 trip；而 contentEnd
 *      变化但没移动裁剪（L3/L4）→ 复制不变、也不误伤；末行越界（L5）安全。
 *
 * 运行：node --import tsx/esm scripts/verify-selection-stale-guard.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

// 强制纯 OSC 52 路径：K 组要调真实 Ink.copySelectionNoClear()，而 setClipboard()
// 会先 fire-and-forget 一次本机剪贴板工具（Windows 上是 clip.exe）、再 await
// tmux load-buffer。两者都不是本脚本要测的东西，且会让断言依赖宿主环境
// （同 scripts/verify-copy-on-select.mjs 的处理）。
process.env['SSH_CONNECTION'] = 'headless-test'
delete process.env['TMUX']

const { refreshSelectionFingerprint, getSelectedText, startSelection, updateSelection, clearSelection, selectionBounds } =
  await import('../src/ink/selection.js')
const { CharPool, HyperlinkPool, StylePool, createScreen, migrateScreenPools } =
  await import('../src/ink/screen.js')
import type { Screen } from '../src/ink/screen.js'
import type { SelectionState as SelState } from '../src/ink/selection.js'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** 最小 Screen，但带**真实** CharPool：指纹现在解析 charId→文本，池不能再是
 *  摆设（旧版只读 cells/noSelect/width/height，任意数字 ID 都能过）。 */
function makeScreen(rows: number, cols: number): Screen {
  return {
    width: cols,
    height: rows,
    cells: new Int32Array(rows * cols * 2),
    noSelect: new Uint8Array(rows * cols),
    softWrap: new Int32Array(rows),
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
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

/** 写一个窄字符 cell，走屏幕自己的 charPool（= 生产 setCellAt 的路径）。 */
function putText(s: Screen, col: number, row: number, text: string): void {
  const ci = (row * s.width + col) * 2
  s.cells[ci] = s.charPool.intern(text)
  s.cells[ci + 1] = 0 // width = Narrow(0)
}

/** 直接写原始 charId + 宽度位（E 组要伪造 spacer / 观察被跳过格）。 */
function putRaw(s: Screen, col: number, row: number, charId: number, width: number): void {
  const ci = (row * s.width + col) * 2
  s.cells[ci] = charId
  s.cells[ci + 1] = width
}

// ── A. 首帧基线 ──────────────────────────────────────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 3)
  putText(screen, 0, 1, 'A')
  putText(screen, 0, 2, 'B')
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
  putText(screen, 0, 1, 'a')
  refreshSelectionFingerprint(sel, screen, false)
  // 行内容被另一段文本替换（同样位置，不同字符）
  putText(screen, 0, 1, 'b')
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
  putText(screen, 0, 1, 'm')
  refreshSelectionFingerprint(sel, screen, false)
  // follow-shift 帧行内容平移（新行进入选区）
  putText(screen, 0, 1, 'n')
  putText(screen, 1, 1, 'o')
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
  putText(screen, 0, 1, 'sel')
  refreshSelectionFingerprint(sel, screen, false)
  // 选区外的第 3 行整行替换（流式新输出落在选区之外）
  for (let c = 0; c < 10; c++) putText(screen, c, 3, String.fromCharCode(0x4e00 + c))
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('D. out-of-selection replacement does not latch stale', !changed && !sel.stale)
}

// ── E. 被 noSelect/spacer 跳过的 cell 内容变化不影响指纹 ────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 1)
  putText(screen, 0, 1, 'K')
  // 第 5 格是 noSelect（gutter 类），第 6 格是 spacer tail：getSelectedText
  // 跳过它们输出，指纹同样跳过——它们的内容变化对两者都不可见。
  screen.noSelect[1 * 10 + 5] = 1
  putText(screen, 5, 1, 'X')
  putRaw(screen, 6, 1, screen.charPool.intern('Z'), 2) // width = SpacerTail
  refreshSelectionFingerprint(sel, screen, false)
  // 改这两个被跳过格的**内容**（E 组的关键：内容变了但格仍被跳过）
  putText(screen, 5, 1, 'Y')
  putRaw(screen, 6, 1, screen.charPool.intern('W'), 2)
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
  putText(screen, 0, 1, 'p')
  refreshSelectionFingerprint(sel, screen, false)
  putText(screen, 0, 1, 'q')
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
  putText(screen, 0, 1, 'r')
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
  putText(screen, 0, 1, 's')
  refreshSelectionFingerprint(sel, screen, false)
  putText(screen, 0, 1, 't')
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
  putText(screen, 0, 1, 'u')
  refreshSelectionFingerprint(sel, screen, false)
  // 拖选延伸到下一行（几何变化）+ 新行内容——不判 stale
  updateSelection(sel, 9, 2)
  putText(screen, 0, 2, 'v')
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('H. geometry change (drag extension) re-baselines, no stale',
    !changed && !sel.stale)
  // 几何稳定后再原地替换 → 恢复正常守卫
  putText(screen, 0, 2, 'w')
  const relapse = refreshSelectionFingerprint(sel, screen, false)
  check('H2. guard re-arms after re-baseline', relapse && sel.stale)
}

// ── J. softWrap 翻转改变复制结果 → 指纹必须感知 ─────────────────────────
{
  const screen = makeScreen(5, 10)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, 9, 2)
  putText(screen, 0, 1, 'x')
  putText(screen, 0, 2, 'y')
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
  for (let c = 0; c <= 3; c++) putText(screen, c, 1, String.fromCharCode(0x4e00 + c))
  refreshSelectionFingerprint(sel, screen, false)
  // 选区列之外的流式追加（列 5-9 持续输出）——复制不读这些列，不误伤
  for (let c = 5; c < 10; c++) putText(screen, c, 1, String.fromCharCode(0x5f00 + c))
  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('I. streaming append outside the selected columns does not latch stale',
    !changed && !sel.stale)
  // 选区内列被替换 → 正常锁存
  putText(screen, 1, 1, '替')
  const inside = refreshSelectionFingerprint(sel, screen, false)
  check('I2. replacement inside the selected columns still latches', inside && sel.stale)
}

// ── K. 代际池重建（文本不变）不误报，真实复制仍然成功 ───────────────────
//
// 构造方式 = 生产 Ink.resetPools()（ink.tsx:2754）逐字复刻：
//     this.charPool = new CharPool();
//     this.hyperlinkPool = new HyperlinkPool();
//     migrateScreenPools(this.frontFrame.screen, this.charPool, this.hyperlinkPool);
// 同一个屏幕像素内容，字符全部换号。修指纹之前这条是**红**的：第二帧
// h !== coveredFingerprint → selection.stale = true → copySelectionNoClear()
// 返回空并清掉选区，「选区内容已变化，已取消复制」——但内容其实一个字没变。
{
  /** 真实 Ink 实例：copySelectionNoClear() 是本 PR 的提交层实现，只有走真类
   *  才谈得上断言「复制成功 / 被拒绝」，而不是复述它的谓词。私有字段按运行时
   *  形状取用（TS `private` 不是 `#private`）；生产读的正是这两处。 */
  type CopyRig = {
    selection: SelState
    frontFrame: { screen: Screen }
    copySelectionNoClear(): string
  }
  const { Writable } = await import('node:stream')
  const { default: Ink } = await import('../src/ink/ink.js')
  const sink = (): unknown => {
    const s = new Writable({ write(_c, _e, cb) { cb() } }) as unknown as Record<string, unknown>
    s['columns'] = 80
    s['rows'] = 24
    s['isTTY'] = false
    return s
  }
  const rig = new Ink({
    stdout: sink(), stderr: sink(), stdin: sink(),
    exitOnCtrlC: false, patchConsole: false,
  } as never) as unknown as CopyRig

  const stylePool = new StylePool()
  const charPool = new CharPool()
  // 模拟代际积累：旧池里已经有别的**历史**字符（曾经上过屏、后来滚走的行、
  // back frame 的 intern）。生产 resetPools 的常态就是如此——旧池的号是一整
  // 个会话的分配史，新池只按「当前 front frame 的行序」重新 intern，两者必
  // 然错开。少了这一段，构造出的新池会恰好复用旧号，K0 就抓不到「重建」。
  for (const ch of '历史遗留 content X') charPool.intern(ch)
  const screen = createScreen(40, 8, stylePool, charPool, new HyperlinkPool())
  const TEXT = '[直接]美国1 原生IP'
  const cells = [...TEXT].map(c => screen.charPool.intern(c)) // 写一列字符，全部窄格
  for (let i = 0; i < cells.length; i++) putRaw(screen, i, 1, cells[i]!, 0)
  const sel = makeSel()
  startSelection(sel, 0, 1)
  updateSelection(sel, cells.length - 1, 1)
  rig.selection = sel
  rig.frontFrame = { ...(rig.frontFrame as object), screen } as CopyRig['frontFrame']

  check('K. precondition: first frame baselines, no verdict',
    !refreshSelectionFingerprint(sel, screen, false) && !sel.stale)

  // 代际池重建：屏幕 cell 的 charId 全部换号，可见文本一个字不变。
  const idsBefore = []
  for (let i = 0; i < cells.length; i++) idsBefore.push(screen.cells[(1 * screen.width + i) * 2]!)
  const freshPool = new CharPool()
  migrateScreenPools(screen, freshPool, new HyperlinkPool())
  const idsAfter = []
  for (let i = 0; i < cells.length; i++) idsAfter.push(screen.cells[(1 * screen.width + i) * 2]!)
  const renumbered = idsBefore.filter((id, i) => id !== idsAfter[i]).length
  // 先证明构造真的咬人：否则「不判 stale」可能只是因为 charId 压根没变。
  check('K0. pool rebuild actually renumbered the covered cells',
    renumbered > 0, `renumbered ${renumbered}/${cells.length}`)
  check('K0b. text under the highlight is byte-identical after the rebuild',
    getSelectedText(sel, screen) === TEXT,
    JSON.stringify(getSelectedText(sel, screen)))

  const changed = refreshSelectionFingerprint(sel, screen, false)
  check('K1. pool rebuild with unchanged text does not latch stale',
    !changed && !sel.stale)

  const copied = rig.copySelectionNoClear()
  check('K2. copy after a pool rebuild still succeeds with the exact text',
    copied === TEXT, JSON.stringify(copied))

  // K3. 真实替换文本仍然拒绝（守卫没被改钝），且提交路径清掉误导性高亮。
  // 用一条**全新**选区：K2 在 stale 分支里会 clearSelection，复用 sel 会让
  // 这条断言在「K1 已经红了」的树上退化成「没有选区」，而不是独立证据。
  const sel2 = makeSel()
  startSelection(sel2, 0, 1)
  updateSelection(sel2, cells.length - 1, 1)
  refreshSelectionFingerprint(sel2, screen, false) // 在已重建的池上取基线
  putRaw(screen, 1, 1, screen.charPool.intern('疑'), 0)
  const relapse = refreshSelectionFingerprint(sel2, screen, false)
  check('K3. real in-place replacement after the rebuild still latches stale',
    relapse && sel2.stale)
  rig.selection = sel2
  const refused = rig.copySelectionNoClear()
  check('K4. stale copy is refused (empty) and the highlight is cleared',
    refused === '' && selectionBounds(sel2) === null)
}

// ── L. 选区**下一行**的 softWrap 也是复制结果的输入 ──────────────────────
//
// extractRowText 读 softWrap[row + 1] 当**本行**的 contentEnd：>0 表示本行折
// 进下一行，于是末列裁到 min(colEnd, contentEnd - 1) 且不再 trim 尾部空白。
// 只翻转下一行的 wrap 位就能改写末行的尾部内容，而本行 cell 一个都没动——
// 指纹不把 softWrap[row + 1] 算进去就会漏检（实测 copy 从 "A" 变
// "A         "）。
{
  const screen = makeScreen(5, 12)
  const sel = makeSel()
  startSelection(sel, 0, 2)
  updateSelection(sel, 9, 2) // 只选第 2 行（end.row = 2 < height-1）
  putText(screen, 0, 2, 'A')
  refreshSelectionFingerprint(sel, screen, false)
  const before = getSelectedText(sel, screen)
  check('L0. precondition: copy is the bare line (trailing blanks trimmed)',
    before === 'A', JSON.stringify(before))
  // 只翻转第 3 行（选区**之下**）的 softWrap 位，第 2 行一个 cell 都不动。
  screen.softWrap[3] = 40
  const after = getSelectedText(sel, screen)
  check('L1. flipping only the row BELOW changes the copied text',
    after !== before, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  const tripped = refreshSelectionFingerprint(sel, screen, false)
  check('L2. the guard trips on a next-row soft-wrap flip', tripped && sel.stale)
}

// ── L3/L4. contentEnd 变了但没移动裁剪 → 复制不变，也不许误伤 ────────────
{
  const screen = makeScreen(5, 12)
  const sel = makeSel()
  startSelection(sel, 0, 2)
  updateSelection(sel, 3, 2) // colEnd = 3
  putText(screen, 0, 2, 'A')
  screen.softWrap[3] = 20 // contentEnd 20 > colEnd → 裁到 colEnd
  refreshSelectionFingerprint(sel, screen, false)
  const before = getSelectedText(sel, screen)
  screen.softWrap[3] = 40 // contentEnd 40，仍 > colEnd → 同一裁剪
  const after = getSelectedText(sel, screen)
  check('L3. a contentEnd change that does not move the clamp leaves the copy identical',
    before === after, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  const tripped = refreshSelectionFingerprint(sel, screen, false)
  check('L4. ... and does not trip the guard', !tripped && !sel.stale)
}

// ── L5. 选区落在屏幕最后一行：row+1 越界必须安全，本行 softWrap 仍在指纹里 ─
{
  const screen = makeScreen(5, 12)
  const sel = makeSel()
  startSelection(sel, 0, 4) // 第 4 行 = 最后一行（height = 5）
  updateSelection(sel, 3, 4)
  putText(screen, 0, 4, 'Z')
  refreshSelectionFingerprint(sel, screen, false)
  const base = getSelectedText(sel, screen)
  screen.softWrap[4] = 9 // 自己那行的 wrap 位（joinRows 的换行判定）
  const tripped = refreshSelectionFingerprint(sel, screen, false)
  check('L5. last screen row: own softWrap still hashed, out-of-range row+1 read is safe',
    tripped && sel.stale && base === 'Z')
}

console.log(failures === 0 ? 'selection stale-guard regression passed' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
