/**
 * SGR 鼠标上报分片回归（#1160 macOS→SSH 会话重启后 / #1120 WSL2 + dsh web）。
 *
 * 一条上报被拆到多次 stdin read、而 App 的 50ms escape flush 落在头片段上时，
 * `ESC[` / `ESC[<` 会被吐成普通 token 落进草稿（DESIGN §0.6.2 矩阵：2-way 只有
 * cut=2/3 泄漏，3-way 随 a=1/2/3 扩散）。本脚本穷举 2-way / 3-way 切点，断言
 * 草稿收到的文本里不出现上报字节，并覆盖反吞噬表与 hold 上界/到期释放。
 *
 * 口径 = InputEvent.input（prompt-input 的消费链）：单个 kind='key' 的
 * sequence 不等于落进草稿的文本——轮事件按既有契约保留为可路由的 ParsedKey，
 * 文本由 input-event 清空。修复落地前（未改 src/ink/parse-keypress.ts）本脚本
 * 必红：切分矩阵与 hold 上界两组即 AC-3 的红侧证据。
 *
 * Run: node --import tsx/esm scripts/verify-mouse-report-fragments.tsx [--controls-only]
 * Exits 1 if any assertion fails (CI gate).
 */
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
} from '../src/ink/parse-keypress.js'
import { InputEvent } from '../src/ink/events/input-event.js'

const ESC = '\x1b'

/** 上报形状（SGR 1006）：移动 / 按下 / 释放 / 滚轮。 */
const REPORTS: Array<[name: string, report: string]> = [
  ['motion', `${ESC}[<35;10;10M`],
  ['press', `${ESC}[<0;10;10M`],
  ['release', `${ESC}[<0;10;10m`],
  ['wheel', `${ESC}[<64;10;10M`],
]
const CLICK = `${ESC}[<0;10;10M`

type Run = { keys: ParsedInput[]; state: KeyParseState; text: string }

/**
 * 驱动解析器。`null` = App 的 escape flush 哨兵；`text` 经 InputEvent 采集，
 * 与 prompt-input 的消费链一致（同 verify-win32-input 的 drive()）。
 */
function drive(start: KeyParseState, chunks: Array<string | null>): Run {
  let state = start
  const keys: ParsedInput[] = []
  for (const chunk of chunks) {
    const [out, next] = parseMultipleKeypresses(state, chunk)
    state = next
    keys.push(...out)
  }
  return { keys, state, text: keys.flatMap(key => (key.kind === 'key' ? [new InputEvent(key).input] : [])).join('') }
}

/**
 * 宿主注入证据位（App 每次 processInput 注入，缺省 false）。矩阵与对照组用
 * `true`：真实泄漏窗口正是"追踪已开、鼠标在动"的时候（D2）。
 */
const withReporting = (reporting: boolean): KeyParseState =>
  ({ ...INITIAL_STATE, mouseReportingActive: reporting }) as KeyParseState

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`ok   ${label}`)
    return
  }
  failures++
  console.log(`FAIL ${label}${detail === '' ? '' : ' :: ' + detail}`)
}

// --- (a)/(b) 2-way / 3-way 切分矩阵 -----------------------------------------
// 穷举切点，每个切点后调一次 flush。先解析一条完整上报点亮 P2 证据：D4 规定
// `ESC[`/`[` 形状另需"窗口内出现过真实 kind:'mouse'"才 hold，冷态 cut=2 是 D4
// 登记的已知边界，不在本矩阵验收内。
const SAMPLES = 3

/** 单条上报的切分扫描：泄漏的 2-way 切点 + 3-way 组合（含首次泄漏的文本）。 */
function scan(state: KeyParseState, report: string): { cuts: number[]; combos: string[] } {
  const cuts: number[] = []
  for (let cut = 1; cut < report.length; cut++) {
    const text = drive(state, [report.slice(0, cut), null, report.slice(cut)]).text
    if (text !== '') cuts.push(cut)
  }
  const combos: string[] = []
  for (let a = 1; a < report.length - 1; a++) {
    for (let b = a + 1; b < report.length; b++) {
      const text = drive(state, [report.slice(0, a), null, report.slice(a, b), null, report.slice(b)]).text
      if (text !== '') combos.push(`a=${a} b=${b} -> ${JSON.stringify(text)}`)
    }
  }
  return { cuts, combos }
}

function matrix(): void {
  const state = drive(withReporting(true), [CLICK]).state
  let twoTotal = 0
  let twoLeaks = 0
  let threeTotal = 0
  let threeLeaks = 0
  const shape: string[] = []
  for (const [name, report] of REPORTS) {
    const { cuts, combos } = scan(state, report)
    twoTotal += report.length - 1
    threeTotal += ((report.length - 2) * (report.length - 1)) / 2
    twoLeaks += cuts.length
    threeLeaks += combos.length
    if (cuts.length > 0 || combos.length > 0) {
      shape.push(`${name}[2-way cut=${cuts.join(',')}；3-way ${combos.length} 组：${combos.slice(0, SAMPLES).join('；')}]`)
    }
  }
  failures += twoLeaks + threeLeaks
  console.log(`2-way 切点 ${twoTotal} 个，泄漏 ${twoLeaks} 个`)
  console.log(`3-way 组合 ${threeTotal} 个，泄漏 ${threeLeaks} 个`)
  console.log(`各形状泄漏面 -> ${shape.join(' ')}`)
  console.log(`切分矩阵失败切点合计 ${twoLeaks + threeLeaks}（DESIGN §0.6.2 验收线 ≥26；修复前必红）`)
}

// --- (c) 反吞噬表 ------------------------------------------------------------
// provenance=false（inline / 未开追踪）时解析层必须与 base 字节级一致：用户手打
// 的 `[`-led 字面文本原样通过。字面键入按逐字符读入建模（真实键入形态）；整条
// 批量到达的 `[<35;10` 命中的是既有 hold 语义，不属本表。
function antiSwallow(): void {
  for (const typed of ['[<35;10', '[<', '[MAX]', '35;10;10M', '<35', '[']) {
    const run = drive(withReporting(false), [...typed])
    check(`字面键入原样通过 ${JSON.stringify(typed)}`, run.text === typed, JSON.stringify(run.text))
  }
  const escaped = drive(withReporting(false), [ESC, null, '['])
  check('先 Esc 再 [ 不被吞（provenance=false）', escaped.text === '[', JSON.stringify(escaped.text))
  const acrossFlush = drive(withReporting(false), ['[', '<', '3', null, '5;10'])
  check('字面键入跨 flush 不被吞', acrossFlush.text === '[<35;10', JSON.stringify(acrossFlush.text))
}

// --- (d) hold 上界与到期释放 -------------------------------------------------
// D5：到期/超上界不静默丢弃，改为把持有字节按普通键回放（不丢字节、不重复）。
// base 只静默丢弃 → 本组红属预期。
function holdBounds(): void {
  const originalNow = Date.now
  let now = 6_000_000
  Date.now = () => now
  try {
    const captured = drive(withReporting(true), [`${ESC}[<35;10`, null])
    check('头片段 hold 期不出文本', captured.text === '', JSON.stringify(captured.text))
    now += 1_001 // 越过 MOUSE_TAIL_HOLD_GRACE_MS（1000ms）：首捕获计时到期的第一刻
    const released = drive(captured.state, [null, null])
    check('1000ms 到期回放持有字节（不丢不重复）', released.text === '[<35;10', JSON.stringify(released.text))
    const afterRelease = drive(released.state, ['x'])
    check('到期回放后普通键入不被吞', afterRelease.text === 'x', JSON.stringify(afterRelease.text))
  } finally {
    Date.now = originalNow
  }
  const oversized = `${ESC}[<${'1'.repeat(70)}`
  const big = drive(withReporting(true), [oversized, null, null])
  check('>64B 持有字节回放（不丢不重复）', big.text === oversized.slice(1), JSON.stringify(big.text.slice(0, 24)))
  const afterBig = drive(big.state, ['x'])
  check('>64B 回放后普通键入不被吞', afterBig.text === 'x', JSON.stringify(afterBig.text))
}

// --- (e) 对照组 --------------------------------------------------------------
// 既有防线必须仍然成立：整条到达 = mouse 事件；Esc 单独 flush 后完整尾巴仍合成
// 完整上报。滚轮按既有契约保留为 ParsedKey（keybinding 需要坐标），文本清空。
function controls(): void {
  for (const [name, report] of REPORTS) {
    const wheel = name === 'wheel'
    const whole = drive(withReporting(true), [report])
    const only = whole.keys[0]
    check(
      `整条到达仍是单个${wheel ? '可路由轮事件' : ' mouse 事件'}且无文本（${name}）`,
      whole.keys.length === 1 &&
        whole.text === '' &&
        (wheel
          ? only?.kind === 'key' && only.name === 'wheelup' && only.sequence === report
          : only?.kind === 'mouse' && only.action === (name === 'release' ? 'release' : 'press')),
      JSON.stringify(whole.text),
    )
    const orphan = drive(withReporting(true), [ESC, null, report.slice(1)])
    const tail = orphan.keys.at(-1)
    check(
      `Esc 单独 flush 后完整尾巴仍合成上报（${name}）`,
      orphan.text === '' && (wheel ? tail?.kind === 'key' && tail.name === 'wheelup' : tail?.kind === 'mouse'),
      JSON.stringify(orphan.text),
    )
  }
  check('对照组不污染 INITIAL_STATE', INITIAL_STATE.incomplete === '' && INITIAL_STATE.mouseTailHold === undefined)
  check('缺省（未注入证据）等同 provenance=false', drive(INITIAL_STATE, [ESC, null, '[']).text === '[')
}

const controlsOnly = process.argv.includes('--controls-only')
if (controlsOnly) {
  controls()
} else {
  matrix()
  antiSwallow()
  holdBounds()
  controls()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log(controlsOnly ? '\nCONTROL-OK' : '\nall mouse-report-fragment assertions passed')
