/**
 * KernelPicker 回归（内核选择器的展示组件）：
 *   1. 视觉照 ModePicker：Pane + 标题（kernel-picker-title）+ 行列表 + Enter/Esc
 *      提示行（hint-confirm-exit）；
 *   2. 一行一个内核：标签走 i18n（kernel-label-*），副标题是 kernelSubtitle 的
 *      「版本 · 置灰原因」（版本串带产品前缀：dsh-core / claude-code）；
 *   3. 当前内核行打勾（✓ 跟着 current 走，不是固定在第一行）；
 *   4. 不可选行变暗（主题 inactive 色，与该行副标题同色），但焦点落在
 *      它上面时 ❯ 指针照样看得见——这正是不能用 ListItem 的 disabled 的原因
 *      （renderIndicator 在 disabled 时只画一格空格，指针被吞掉）；
 *   5. pinned 时才多画一行 kernel-pinned-hint；
 *   6. 鼠标点行回调行号（宿主走与 Enter 相同的确认路径）；没接
 *      onPick 时行不可点、也没有 hover 反馈（挂得上 onClick 才给 hover）。
 *
 * 运行：node --import tsx/esm scripts/verify-kernel-picker.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { settle, settled, sleep, viewportLines } from './lib/term-test.mjs'
import { stringWidth } from '../src/ink/stringWidth.js'

const { Terminal: XTerm } = xterm
const [
  { render, AlternateScreen, useInput },
  { KernelPicker },
  { buildKernelCatalog },
  { t, setLang },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/components/KernelPicker.js'),
  import('../src/components/kernelCatalog.js'),
  import('../src/i18n.js'),
])

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log('ok   ' + name)
  else {
    failures++
    console.error('FAIL ' + name + (extra === '' ? '' : '\n      ' + extra))
  }
}

/**
 * 键盘/鼠标都挂在同一个 stdin 上：KernelPicker 自己不调 useInput（键盘归宿主），
 * 没有这一格 raw-mode 保持器时 App 从不订阅 stdin，注入的鼠标事件会**静默丢掉**
 *（仓库里踩过的坑：点击用例假失败，看着像组件没接线）。
 */
function RawMode(): null {
  useInput((): void => {}, { isActive: true })
  return null
}

class FakeStdout extends Writable {
  isTTY = true
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

const COLS = 80
const ROWS = 14

/** 该行第一个非空格字符的单元格（前缀的两格标记/缩进不参与定位）。 */
function firstGlyphCell(term: InstanceType<typeof XTerm>, row: number, columns: number) {
  const line = row < 0 ? undefined : term.buffer.active.getLine(row)
  if (line === undefined) return undefined
  for (let col = 0; col < columns; col++) {
    const cell = line.getCell(col)
    if ((cell?.getChars() ?? '').trim() !== '') return cell
  }
  return undefined
}

/**
 * 前景色判据串。**别用 xterm 的 isDim() 判「变暗」**：本仓 dimColor 是 ThemedText
 * 的语义（换成主题 inactive 色），根本不发 ANSI 2——拿 isDim 判会永远读到 0。
 */
function fgKeyOf(cell: ReturnType<typeof firstGlyphCell>): string {
  if (cell === undefined) return 'none'
  if (cell.isFgDefault()) return 'default'
  if (cell.isFgRGB()) return 'rgb:' + cell.getFgColor().toString(16)
  if (cell.isFgPalette()) return 'palette:' + cell.getFgColor()
  return 'ansi:' + cell.getFgColor()
}

/** 行内某段文字**首字符**的单元格（前缀须是 ASCII——列号按显示宽度算）。 */
function cellAtText(term: InstanceType<typeof XTerm>, lines: readonly string[], row: number, needle: string) {
  const text = row < 0 ? '' : lines[row] ?? ''
  const at = text.indexOf(needle)
  const line = row < 0 ? undefined : term.buffer.active.getLine(row)
  if (line === undefined || at < 0) return undefined
  return line.getCell(stringWidth(text.slice(0, at)))
}

/** 挂一份 KernelPicker（真 render + 假 TTY），返回读屏 / 注入 / 收尾三件套。 */
async function mountPicker(options: {
  options: readonly unknown[]
  focusIndex: number
  pinned?: boolean
  pick?: boolean
  columns?: number
  rows?: number
}) {
  const columns = options.columns ?? COLS
  const rows = options.rows ?? ROWS
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const input = new FakeStdin()
  const picked: number[] = []
  const app = await render(
    <AlternateScreen mouseTracking={true}>
      <RawMode />
      <KernelPicker
        options={options.options as never}
        focusIndex={options.focusIndex}
        pinned={options.pinned}
        onPick={options.pick === true ? (index: number) => { picked.push(index) } : undefined}
      />
    </AlternateScreen>,
    {
      stdin: input as never,
      stdout: new FakeStdout(term) as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const lines = (): string[] => viewportLines(term)
  // 首帧落定再交给用例：render() 返回不等于画完（比「固定 sleep 后断言」稳）。
  await settled(() => lines().some(line => line.trim() !== ''))
  const rowOf = (needle: string): number => lines().findIndex(line => line.includes(needle))
  /** 某个 needle 的终端列号（1 起，SGR 用）。 */
  const colOf = (needle: string): { col: number; row: number } => {
    const all = lines()
    const row = all.findIndex(line => line.includes(needle))
    if (row < 0) return { col: -1, row: -1 }
    return { col: stringWidth(all[row]!.slice(0, all[row]!.indexOf(needle))) + 1, row: row + 1 }
  }
  /** 真 SGR 点击（按下 + 抬起）：落在 needle 首字符那一格。 */
  const click = async (needle: string, expect = true): Promise<void> => {
    await settle(() => rowOf(needle) >= 0)
    const at = colOf(needle)
    if (at.col < 0) throw new Error('click target not on screen: ' + needle)
    const seq = '\u001b[<0;' + at.col + ';' + at.row
    const before = picked.length
    input.write(seq + 'M')
    input.write(seq + 'm')
    if (expect) await settle(() => picked.length > before)
    else await sleep(120) // 固定窗:探针 断言「点击不得产生回调」——没有可轮询的完成条件，只能等一个观察窗
  }
  /** 无按键 motion（mode 1003，SGR 35）——hover 路径。 */
  const hover = async (needle: string): Promise<void> => {
    await settle(() => rowOf(needle) >= 0)
    const at = colOf(needle)
    if (at.col < 0) throw new Error('hover target not on screen: ' + needle)
    input.write('\u001b[<35;' + at.col + ';' + at.row + 'M')
    await sleep(120) // 固定窗:探针 hover 反馈是「有则变、无则不变」——不可点时必须等一个观察窗再断言零变化
  }
  return { term, input, picked, lines, rowOf, click, hover, close: () => app.unmount() }
}

const PROBING = buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.0-rc.2' })
const READY = buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.0-rc.2', claude: { installed: true, auth: 'ok', version: '2.1.0' } })
const NOT_INSTALLED = buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.0-rc.2', claude: { installed: false } })
/** 当前内核 = claude：勾要跟着挪到第二行（不是钉死在第一行）。 */
const CLAUDE_CURRENT = buildKernelCatalog({ current: 'claude', dshVersion: '0.2.0-rc.2', claude: { installed: true, auth: 'ok', version: '2.1.0' } })

const DSH_LABEL = t('kernel-label-dsh')
const CLAUDE_LABEL = t('kernel-label-claude')
const TICK = '\u2713'
const POINTER = '\u276f'

// ── 1. 骨架：标题 / 两行标签 / 副标题 / 提示行 / pinned 缺席 ──────────────────
{
  const picker = await mountPicker({ options: PROBING, focusIndex: 0, pick: true })
  const screen = picker.lines().join('\n')
  check('1 标题 = kernel-picker-title（选择内核）', screen.includes(t('kernel-picker-title')), screen.slice(0, 200))
  check('2 两行标签 = kernel-label-dsh / kernel-label-claude',
    screen.includes(DSH_LABEL) && screen.includes(CLAUDE_LABEL), screen)
  check('3a 副标题：dsh 行是版本显示串（dsh-core v0.2.0-rc.2）',
    screen.includes('dsh-core v0.2.0-rc.2'), screen)
  check('3b 副标题：探测未回来的 claude 行是「检测中…」（不是「未安装」）',
    screen.includes(t('kernel-probing')) && !screen.includes(t('kernel-unavailable-not-installed')), screen)
  check('4 提示行 = hint-confirm-exit（Enter 确认 · Esc 退出）', screen.includes('Enter 确认 · Esc 退出'), screen)
  check('5 pinned 缺席时不画 kernel-pinned-hint',
    !screen.includes(t('kernel-pinned-hint').slice(0, 8)), screen)
  picker.close()
}

// ── 2. 当前标记 / 焦点指针 / 不可选行变暗（焦点压上去也不亮）─────────────────
{
  const picker = await mountPicker({ options: NOT_INSTALLED, focusIndex: 1, pick: true })
  const lines = picker.lines()
  const dshRow = picker.rowOf(DSH_LABEL)
  const claudeRow = picker.rowOf(CLAUDE_LABEL)
  const tickRow = picker.rowOf(TICK)
  check('6 当前内核行打勾：✓ 与 dsh 标签在**同一行**',
    tickRow >= 0 && tickRow === dshRow && dshRow !== claudeRow,
    `tick=${tickRow} dsh=${dshRow} claude=${claudeRow}`)
  check('7 焦点落在**不可选**行上时 ❯ 指针照样在（disabled 会把它吞掉）',
    picker.rowOf(POINTER) === claudeRow && dshRow >= 0 && lines[claudeRow]!.includes(CLAUDE_LABEL),
    `pointer=${picker.rowOf(POINTER)} claude=${claudeRow} : ${JSON.stringify(lines[claudeRow]?.trim())}`)
  // 标签格要按**文字**取，不能取该行第一个字形——不可选行聚焦时第一个字形是
  // ❯ 指针（suggestion 色），它本来就是亮的。副标题是 ListItem 的 description，
  // 落在标签行的**下一行**（同色是「变暗 = 主题 inactive」的直接证据）。
  const claudeFg = fgKeyOf(cellAtText(picker.term, lines, claudeRow, CLAUDE_LABEL))
  const dshFg = fgKeyOf(cellAtText(picker.term, lines, dshRow, DSH_LABEL))
  const subtitleFg = fgKeyOf(firstGlyphCell(picker.term, picker.rowOf(t('kernel-unavailable-not-installed')), COLS))
  check('8 不可选行变暗用主题 inactive 色（与该行副标题同色），当前行是 success 色',
    claudeFg === subtitleFg && claudeFg !== 'default' && dshFg !== claudeFg,
    `claude=${claudeFg} subtitle=${subtitleFg} dsh=${dshFg}`)
  // 鼠标：点行回行号——不可选行也照样回（宿主决定提示还是重启，组件不替它决定）。
  await picker.click(CLAUDE_LABEL)
  await picker.click(DSH_LABEL)
  check('9 鼠标点行回行号（claude → 1、dsh → 0）',
    picker.picked.length === 2 && picker.picked[0] === 1 && picker.picked[1] === 0,
    JSON.stringify(picker.picked))
  picker.close()
}

// ── 3. 勾跟着当前内核挪位（current=claude）─────────────────────────────────
{
  const picker = await mountPicker({ options: CLAUDE_CURRENT, focusIndex: 1 })
  const tickRow = picker.rowOf(TICK)
  check('10 current=claude：✓ 落在 claude 行上，dsh 行没有勾',
    tickRow === picker.rowOf(CLAUDE_LABEL) && tickRow !== picker.rowOf(DSH_LABEL),
    `tick=${tickRow} claude=${picker.rowOf(CLAUDE_LABEL)} dsh=${picker.rowOf(DSH_LABEL)}`)
  picker.close()
}

// ── 4. 未安装 / 可用两档的副标题与变暗范围 ──────────────────────────────────
{
  const notInstalled = await mountPicker({ options: NOT_INSTALLED, focusIndex: 0 })
  check('11 未安装的 claude 行副标题是「未安装」',
    notInstalled.lines().join('\n').includes(t('kernel-unavailable-not-installed')),
    notInstalled.lines().join('\n'))
  notInstalled.close()
  const ready = await mountPicker({ options: READY, focusIndex: 0 })
  const readyScreen = ready.lines().join('\n')
  check('12 可用的 claude 行副标题是探测到的版本串（claude-code v2.1.0）',
    readyScreen.includes('claude-code v2.1.0'), readyScreen)
  const claudeRow = ready.rowOf(CLAUDE_LABEL)
  const dshRow = ready.rowOf(DSH_LABEL)
  const claudeFg = fgKeyOf(firstGlyphCell(ready.term, claudeRow, COLS))
  const dshFg = fgKeyOf(firstGlyphCell(ready.term, dshRow, COLS))
  check('13 dim 只落在不可选行上：可用的 claude 行是默认前景，当前行是 success 色',
    claudeFg === 'default' && dshFg !== claudeFg, `claude=${claudeFg} dsh=${dshFg}`)
  ready.close()
}

// ── 5. pinned 提示行 / en 语言 / 窄屏 ────────────────────────────────────────
{
  const pinned = await mountPicker({ options: PROBING, focusIndex: 0, pinned: true })
  check('14 pinned=true 多画一行 kernel-pinned-hint',
    await settled(() => pinned.lines().join('\n').includes(t('kernel-pinned-hint').slice(0, 8))),
    pinned.lines().join('\n'))
  pinned.close()
  setLang('en')
  const en = await mountPicker({ options: PROBING, focusIndex: 0 })
  const enScreen = en.lines().join('\n')
  check('15 en：标题与提示行跟着换（Choose kernel / Enter to confirm）',
    enScreen.includes('Choose kernel') && enScreen.includes('Enter to confirm'), enScreen)
  setLang('zh')
  en.close()
  const narrow = await mountPicker({ options: PROBING, focusIndex: 0, columns: 34, rows: 12 })
  const over = narrow.lines().map((line, i) => ({ w: stringWidth(line.replace(/\s+$/u, '')), i })).filter(x => x.w > 34)
  check('16 窄终端（34 列）任何一行都不超宽', over.length === 0, over.map(x => 'row=' + x.i + ' w=' + x.w).join(' '))
  narrow.close()
}

// ── 6. 没接 onPick：行不可点、也没有 hover 反馈 ──────────────────────────────
{
  const inert = await mountPicker({ options: READY, focusIndex: 0 })
  const claudeRow = inert.rowOf(CLAUDE_LABEL)
  const bgDefault = (): boolean => {
    const line = inert.term.buffer.active.getLine(claudeRow)
    for (let col = 0; col < COLS; col++) {
      const cell = line?.getCell(col)
      if (cell === undefined) continue
      if (!cell.isBgDefault()) return false
    }
    return true
  }
  const before = bgDefault()
  await inert.hover(CLAUDE_LABEL)
  await inert.click(CLAUDE_LABEL, false)
  check('17 onPick 缺席：悬停不给背景反馈（挂得上 onClick 才给 hover）', before && bgDefault(),
    'before=' + before + ' after=' + bgDefault())
  check('18 onPick 缺席：点击不产生任何回调', inert.picked.length === 0, JSON.stringify(inert.picked))
  inert.close()
}

if (failures === 0) console.log('\nverify-kernel-picker: all passed')
else console.error('\nverify-kernel-picker: ' + failures + ' checks FAILED')
process.exit(failures === 0 ? 0 : 1)
