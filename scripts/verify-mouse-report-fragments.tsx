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
 * T04 补强（只加断言，不改实现）：ADR-0007 D4 的两级证据边界（冷 P2 的
 * `ESC[` 不 hold、P2 点亮后 `[<`/`ESC[<`/`ESC[` 三形态 hold）、D5 的到期/
 * 超限 RELEASE 回放（不吞不重）、P2 过期与宿主注入开关、closed 批量形状
 * 零认领，以及 INITIAL_STATE 全字段不被污染。
 *
 * T-FIX-01 补强：
 *  - F-1：gated hold 在任何作废路径（非续接普通文本 / 新 head 替换）按到达顺序
 *    RELEASE，不再静默丢字节；
 *  - F-2：单次 read 内形成的 `ESC[`（传输层证据）冷 P2 也可由 P1 claim，跨 read
 *    累积的 `ESC[` 仍按 D4 需 P2；
 *  - F-3：scan() 除零文本外必须断言补齐后事件仍触发（mouse / 滚轮 key）；
 *  - F-4：结构化注入契约断言（App 注入点唯一 + getter + 三态→布尔 + 字段名）。
 *
 * Run: node --import tsx/esm scripts/verify-mouse-report-fragments.tsx [--controls-only]
 * Exits 1 if any assertion fails (CI gate).
 */
import { readFileSync } from 'node:fs'
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

/**
 * gated 家族的三种头形态（D4）：文本 token / 带 ESC 的 sequence token / 需要
 * P2 证据的歧义 `ESC[`。`chunk` 按「整段到达 + flush」投喂，`held` 是去 ESC
 * 后应持有的字节。
 */
const GATED_HEADS: Array<[label: string, chunk: string, held: string]> = [
  ['[<', '[<', '[<'],
  ['ESC[<', `${ESC}[<`, '[<'],
  ['ESC[', `${ESC}[`, '['],
]

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

/** P2 证据预热：先解析一条真实 kind:'mouse' 上报（宿主注入 true）。 */
const warmP2 = (): KeyParseState => drive(withReporting(true), [CLICK]).state

let failures = 0
let passed = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`ok   ${label}`)
    return
  }
  failures++
  console.log(`FAIL ${label}${detail === '' ? '' : ' :: ' + detail}`)
}

// --- (a)/(b) 2-way / 3-way 切分矩阵 -----------------------------------------
// 穷举切点，每个切点后调一次 flush。全覆盖矩阵用 P2 已点亮状态（D4 规定跨 read
// 累积的 `ESC[` 仍需 P2）；冷 P2 不再被 warmP2() 静默排除，以显式用例进矩阵：
// 单次 read 形成的 `ESC[` 由传输层证据（F-2）在 P1 下 claim，跨 read 累积的
// `ESC[` 仍不 claim、需 P2。
const SAMPLES = 3

/** 补齐后必须触发的事件：点击/拖动/释放 → kind:'mouse'；滚轮 → 既有 wheel key 契约。 */
function completionTriggered(keys: ParsedInput[], wheel: boolean): boolean {
  return wheel
    ? keys.some(key => key.kind === 'key' && (key.name === 'wheelup' || key.name === 'wheeldown'))
    : keys.some(key => key.kind === 'mouse')
}

/**
 * 单条上报的切分扫描 F-3：除「补齐后零文本」外，补齐后必须仍有事件触发
 * （`kind:'mouse'`；滚轮按既有契约是 wheel key）——claim 成功但事件被吞必须红。
 */
function scan(state: KeyParseState, report: string, wheel: boolean): { cuts: number[]; combos: string[]; missed: string[] } {
  const cuts: number[] = []
  const missed: string[] = []
  for (let cut = 1; cut < report.length; cut++) {
    const run = drive(state, [report.slice(0, cut), null, report.slice(cut)])
    if (run.text !== '') cuts.push(cut)
    else if (!completionTriggered(run.keys, wheel)) missed.push(`2-way cut=${cut}`)
  }
  const combos: string[] = []
  for (let a = 1; a < report.length - 1; a++) {
    for (let b = a + 1; b < report.length; b++) {
      const run = drive(state, [report.slice(0, a), null, report.slice(a, b), null, report.slice(b)])
      if (run.text !== '') combos.push(`a=${a} b=${b} -> ${JSON.stringify(run.text)}`)
      else if (!completionTriggered(run.keys, wheel)) missed.push(`3-way a=${a} b=${b}`)
    }
  }
  return { cuts, combos, missed }
}

function matrix(): void {
  const state = warmP2()
  let twoTotal = 0
  let twoLeaks = 0
  let twoMissed = 0
  let threeTotal = 0
  let threeLeaks = 0
  let threeMissed = 0
  const shape: string[] = []
  for (const [name, report] of REPORTS) {
    const wheel = name === 'wheel'
    const { cuts, combos, missed } = scan(state, report, wheel)
    twoTotal += report.length - 1
    threeTotal += ((report.length - 2) * (report.length - 1)) / 2
    twoLeaks += cuts.length
    threeLeaks += combos.length
    twoMissed += missed.filter(item => item.startsWith('2-way')).length
    threeMissed += missed.filter(item => item.startsWith('3-way')).length
    if (cuts.length > 0 || combos.length > 0) {
      shape.push(`${name}[2-way cut=${cuts.join(',')}；3-way ${combos.length} 组：${combos.slice(0, SAMPLES).join('；')}]`)
    }
  }
  failures += twoLeaks + threeLeaks + twoMissed + threeMissed
  console.log(`2-way 切点 ${twoTotal} 个，泄漏 ${twoLeaks} 个，补齐后未触发事件 ${twoMissed} 个`)
  console.log(`3-way 组合 ${threeTotal} 个，泄漏 ${threeLeaks} 个，补齐后未触发事件 ${threeMissed} 个`)
  console.log(`各形状泄漏面 -> ${shape.join(' ')}`)
  console.log(`切分矩阵失败切点合计 ${twoLeaks + threeLeaks + twoMissed + threeMissed}（DESIGN §0.6.2 验收线 ≥26；修复前必红）`)

  // --- 冷 P2 显式矩阵（F-2/F-3）---------------------------------------------
  // 单次 read `ESC[`：两个字节在同一次 read 内由 tokenizer 缓冲形成（进入本次
  // 调用前缓冲为空）——人类两次击键不会落在同一 read，故这是协议头形态证据，
  // P1 即可 claim。跨 read 累积的 `ESC[` 不在同一次 read 内形成，仍按 D4 需 P2。
  const cold = withReporting(true)
  for (const [name, report] of REPORTS) {
    const wheel = name === 'wheel'
    const tail = report.slice(2)
    const eventName = wheel ? 'wheel key' : 'mouse'
    const coldHead = drive(cold, [`${ESC}[`, null])
    check(
      `冷 P2 单 read ESC[ 由传输证据 claim（${name}）`,
      coldHead.text === '' && coldHead.state.mouseTailHold === '[',
      JSON.stringify(coldHead.text),
    )
    const coldDone = drive(coldHead.state, [tail])
    check(
      `冷 P2 单 read ESC[ 补齐后触发 ${eventName}（${name}）`,
      coldDone.text === '' && completionTriggered(coldDone.keys, wheel),
      JSON.stringify(coldDone.text),
    )
    const crossHead = drive(cold, [ESC, '[', null])
    check(
      `冷 P2 跨 read ESC[ 仍不 claim（需 P2，${name}）`,
      crossHead.text === '[' && crossHead.state.mouseTailHold === undefined,
      JSON.stringify(crossHead.text),
    )
    const crossTail = drive(crossHead.state, [tail])
    check(
      `冷 P2 跨 read ESC[ 补齐后仍落文本（D4 登记边界，${name}）`,
      crossHead.text + crossTail.text === `[${tail}`,
      JSON.stringify(crossHead.text + crossTail.text),
    )
    const warmCrossHead = drive(warmP2(), [ESC, '[', null])
    check(
      `P2 点亮后跨 read ESC[ 可由 P2 claim（${name}）`,
      warmCrossHead.text === '' && warmCrossHead.state.mouseTailHold === '[',
      JSON.stringify(warmCrossHead.text),
    )
    const warmCrossDone = drive(warmCrossHead.state, [tail])
    check(
      `P2 点亮后跨 read ESC[ 补齐触发 ${eventName}（${name}）`,
      warmCrossDone.text === '' && completionTriggered(warmCrossDone.keys, wheel),
      JSON.stringify(warmCrossDone.text),
    )
  }
}

// --- (a2) 非续接/替换路径必须 RELEASE（F-1，Critical）------------------------
// gated hold 在任何作废路径都必须按到达顺序回放，不得静默丢弃；legacy hold 保持
// 既有语义。四个实测反例 + 两条「新 head 替换旧 hold」路径。
function nonContinuableRelease(): void {
  const warmed = warmP2()
  const typed = drive(warmed, ['[', 't', 'e', 'x', 't', ']'])
  check('F-1 逐字 [text] 非续接文本 RELEASE 不丢字节', typed.text === '[text]', JSON.stringify(typed.text))

  const escBracket = drive(warmed, [ESC, null, '[', 'a'])
  check('F-1 Esc→flush→[→a 非续接时 [ 不丢', escBracket.text === '[a', JSON.stringify(escBracket.text))

  const bare = drive(warmed, ['[<', 'a'])
  check('F-1 hold [< 遇普通文本 RELEASE 不丢', bare.text === '[<a', JSON.stringify(bare.text))

  const digits = drive(warmed, ['[<35;10', 'x'])
  check('F-1 hold [<35;10 遇普通文本 RELEASE 不丢', digits.text === '[<35;10x', JSON.stringify(digits.text))
  const afterRelease = drive(digits.state, ['y'])
  check('F-1 RELEASE 后普通键入不吞不重', afterRelease.text === 'y', JSON.stringify(afterRelease.text))

  // (b) sequence 路径新 head 替换旧 hold：旧字节必须先回放。
  const held = drive(warmed, ['[<35;10'])
  check('F-1a 前置 hold 建立（[<35;10）', held.text === '' && held.state.mouseTailHold === '[<35;10', JSON.stringify(held.text))
  const replacedSequence = drive(held.state, [`${ESC}[<`, null])
  check(
    'F-1 sequence 新 head 替换旧 hold 时先回放旧字节',
    replacedSequence.text === '[<35;10' && replacedSequence.state.mouseTailHold === '[<',
    JSON.stringify(replacedSequence.text),
  )
  const sequenceDone = drive(replacedSequence.state, ['35;99;99M'])
  check(
    'F-1 新 head 续接后仍合成 mouse',
    sequenceDone.text === '' && sequenceDone.keys.some(key => key.kind === 'mouse'),
    JSON.stringify(sequenceDone.text),
  )

  // (c) text 路径新 head 替换旧 hold：旧字节与新 head 字节都不得丢。
  const replacedText = drive(held.state, ['[<', 'x'])
  check(
    'F-1 text 新 head 替换旧 hold 时回放旧字节且后续不吞',
    replacedText.text === '[<35;10[<x',
    JSON.stringify(replacedText.text),
  )

  // (d) 其它一般作废（完整按键序列）：gated hold 同样 RELEASE，不静默丢。
  const arrow = drive(warmed, ['[<35', `${ESC}[A`])
  check(
    'F-1 一般作废（完整按键序列）同样 RELEASE 不丢',
    arrow.text === '[<35' && arrow.keys.some(key => key.kind === 'key' && key.name === 'up'),
    JSON.stringify(arrow.text),
  )

  // (e) 协议边界（完整鼠标上报）仍按既有语义作废 hold：死报告的字节不得回放成文本。
  const completeReport = drive(warmed, ['[<35', CLICK])
  check(
    'F-1 协议边界（完整上报）作废 hold 且不产生文本',
    completeReport.text === '' && completeReport.keys.some(key => key.kind === 'mouse'),
    JSON.stringify(completeReport.text),
  )
}

// --- (c) 反吞噬表 ------------------------------------------------------------
// provenance=false（inline / 未开追踪）时解析层必须与 base 字节级一致：用户手打
// 的 `[`-led 字面文本原样通过，且 D4「任何形状都不 hold」对逐字符与批量到达
// 一视同仁（closed 门零认领）。字面键入按逐字符读入建模（真实键入形态）。
function antiSwallow(): void {
  for (const typed of ['[<35;10', '[<', '[<35;10;10M', '<35;10;10M', '[MAX]', '35;10;10M', '<35', '[']) {
    const run = drive(withReporting(false), [...typed])
    check(`字面键入原样通过 ${JSON.stringify(typed)}`, run.text === typed, JSON.stringify(run.text))
  }
  const escaped = drive(withReporting(false), [ESC, null, '['])
  check('先 Esc 再 [ 不被吞（provenance=false）', escaped.text === '[', JSON.stringify(escaped.text))
  const acrossFlush = drive(withReporting(false), ['[', '<', '3', null, '5;10'])
  check('字面键入跨 flush 不被吞', acrossFlush.text === '[<35;10', JSON.stringify(acrossFlush.text))
  // T04：一次 read 合并到达的协议形文本（conhost/SSH 批量键入）同样必须逐字节
  // 原样通过——closed 门不得因为「像是上报前缀」把它认领进 hold。
  for (const batched of ['[<', '[<35;10', '<35;10;10M', `${ESC}[<`, `${ESC}[<35;10`, `${ESC}[`]) {
    const run = drive(withReporting(false), [batched, null])
    const expected = batched.replace(/^\x1b/, '')
    check(`closed 批量形状原样通过 ${JSON.stringify(batched)}`, run.text === expected, JSON.stringify(run.text))
  }
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

// --- (e) 证据门控边界（T04 补强） --------------------------------------------
// ADR-0007 D4 的两级证据：P1 = 宿主注入 mouseReportingActive（App 每次
// processInput 注入），P2 = 5s 内解析过真实 kind:'mouse' 上报。四组断言分别
// 钉住：冷/过期 P2、P2 点亮后的三形态 hold 与到期 RELEASE、超 64B RELEASE、
// 宿主注入开关。每组自带前置并独立断言，失败信息能直接指认破的是哪条契约。

/** 假时钟起点（任意单调值）；调用方负责保存并恢复真实 Date.now。 */
const FAKE_EPOCH = 8_000_000

/** 冷 P2 与 P2 过期：跨 read 累积的 `ESC[` 仍需 P2；`[<`/`ESC[<` 只依赖 P1。 */
function gatedColdAndExpiry(): void {
  const originalNow = Date.now
  let now = FAKE_EPOCH
  Date.now = () => now
  try {
    // 冷 P2：注入 true 但没有近期真实上报 —— `[<`/`ESC[<` 仍可由 P1 hold；
    // 跨 read 累积的 `ESC[` 没有「单次 read 传输证据」，仍必须放过（D4）。
    const coldAccumulated = drive(withReporting(true), [ESC, '[', null])
    check(
      'gated 冷 P2 时跨 read 累积的 ESC[ 不 hold（仍需 P2）',
      coldAccumulated.text === '[' && coldAccumulated.state.mouseTailHold === undefined,
      JSON.stringify(coldAccumulated.text),
    )
    const coldEscThenBracket = drive(withReporting(true), [ESC, null, '['])
    check(
      'gated 冷 P2 时 Esc 后接 [ 原样通过',
      coldEscThenBracket.text === '[' && coldEscThenBracket.state.mouseTailHold === undefined,
      JSON.stringify(coldEscThenBracket.text),
    )
    const coldBracketLess = drive(withReporting(true), [`${ESC}[<`, null])
    check(
      'gated 冷 P2 时 ESC[< 仍由 P1 hold（D4 形状分级）',
      coldBracketLess.text === '' && coldBracketLess.state.mouseTailHold === '[<',
      JSON.stringify(coldBracketLess.text),
    )
    // P2 过期（>MOUSE_REPORT_ACTIVITY_MS）：跨 read 的 `ESC[` 回到冷态；
    // `[<` 仍只依赖 P1。
    const warmed = warmP2()
    now += 5_001 // 越过 MOUSE_REPORT_ACTIVITY_MS（5s P2 窗口，ADR-0007 D2）
    const expired = drive(warmed, [ESC, '[', null])
    check(
      'P2 过期后跨 read 累积的 ESC[ 不 hold（回到既有语义）',
      expired.text === '[' && expired.state.mouseTailHold === undefined,
      JSON.stringify(expired.text),
    )
    const p1Only = drive(warmed, ['[<', null])
    check('P2 过期不影响 P1 的 [< hold', p1Only.text === '' && p1Only.state.mouseTailHold === '[<', JSON.stringify(p1Only.text))
  } finally {
    Date.now = originalNow
  }
}

/** P2 点亮：三形态 hold 不出文本，>1000ms 到期 RELEASE 回放，键入不吞不重。 */
function gatedHeads(): void {
  const originalNow = Date.now
  let now = FAKE_EPOCH
  Date.now = () => now
  try {
    const warmed = warmP2()
    check('真实 kind:mouse 上报点亮 P2 证据', warmed.lastMouseReportAt !== undefined)
    for (const [label, chunk, held] of GATED_HEADS) {
      const captured = drive(warmed, [chunk, null])
      check(
        `gated 头片段保持 hold 不出文本（${label}）`,
        captured.text === '' && captured.state.mouseTailHold === held,
        JSON.stringify(captured.text),
      )
      now += 1_001 // 越过 MOUSE_TAIL_HOLD_GRACE_MS（首捕获计时）
      const released = drive(captured.state, [null, null])
      check(`gated 到期 RELEASE 回放持有字节（${label}）`, released.text === held, JSON.stringify(released.text))
      const after = drive(released.state, ['x'])
      check(`gated 到期回放后普通键入不吞不重（${label}）`, after.text === 'x', JSON.stringify(after.text))
    }
  } finally {
    Date.now = originalNow
  }
}

/** 超 64B：续接溢出与整段到达两条入口都必须 RELEASE，不静默丢弃、不重复。 */
function gatedOverflow(): void {
  const OVERSIZED = '1'.repeat(70) // > MOUSE_HEAD_HOLD_MAX_LENGTH（64B，ADR-0007 D5）
  const warmed = warmP2()
  // 文本 token 续接溢出：先持有 `[<`，再由超长数字串触发释放。
  const seeded = drive(warmed, ['[<', null]).state
  const overflowed = drive(seeded, [OVERSIZED])
  check(
    'gated [< 续接超 64B 时 RELEASE 先前持有字节',
    overflowed.text === '[<' + OVERSIZED,
    JSON.stringify(overflowed.text.slice(0, 16)),
  )
  const afterOverflow = drive(overflowed.state, ['x'])
  check('gated 超限 RELEASE 后普通键入不吞不重', afterOverflow.text === 'x', JSON.stringify(afterOverflow.text))
  // 整段 sequence token 到达：超限必须立即 RELEASE，不 hold、不丢字节。
  for (const [label, chunk, held] of GATED_HEADS.slice(1)) {
    const batched = drive(warmed, [`${chunk}${OVERSIZED}`, null])
    check(
      `gated ${label} 整段超 64B 不吞不丢`,
      batched.text === held + OVERSIZED && batched.state.mouseTailHold === undefined,
      JSON.stringify(batched.text.slice(0, 16)),
    )
    const after = drive(batched.state, ['x'])
    check(`gated ${label} 超限后普通键入不吞不重`, after.text === 'x', JSON.stringify(after.text))
  }
}

/** 宿主注入是权威：false 立即关门（inline/未开追踪零认领），true 重新开门。 */
function gatedInjectionToggle(): void {
  const closed = { ...warmP2(), mouseReportingActive: false } as KeyParseState
  const closedRun = drive(closed, ['[<', null])
  check(
    '注入 false 关门后 [< 原样通过',
    closedRun.text === '[<' && closedRun.state.mouseTailHold === undefined,
    JSON.stringify(closedRun.text),
  )
  const reopened = { ...closedRun.state, mouseReportingActive: true } as KeyParseState
  const reopenedRun = drive(reopened, ['[<', null])
  check(
    '重新注入 true 后 [< 恢复 hold',
    reopenedRun.text === '' && reopenedRun.state.mouseTailHold === '[<',
    JSON.stringify(reopenedRun.text),
  )
}

// --- (f) 对照组 --------------------------------------------------------------
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
        whole.state.mouseTailHold === undefined &&
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
  check(
    '对照组不污染 INITIAL_STATE',
    INITIAL_STATE.incomplete === '' &&
      INITIAL_STATE.mouseTailHold === undefined &&
      INITIAL_STATE.mouseTailHoldAt === undefined &&
      INITIAL_STATE.mouseTailHoldReleasable === undefined &&
      INITIAL_STATE.lastMouseReportAt === undefined &&
      INITIAL_STATE.mouseReportingActive === undefined &&
      INITIAL_STATE.mouseHeadSingleRead === undefined,
  )
  // F-8 标签修正：缺省（absent）只在 Esc+[ 形态上等同 provenance=false；`[<`+数字
  // 仍走 base 的 legacy hold（releasable 非 true、到期静默丢弃）。
  check('缺省（未注入证据）时 Esc+[ 形态等同 closed（不放宽既有语义）', drive(INITIAL_STATE, [ESC, null, '[']).text === '[')
  const legacySeed = drive(INITIAL_STATE, ['[<35;10'])
  check(
    '缺省（未注入证据）时 [<+数字仍进入 legacy hold（releasable 非 true）',
    legacySeed.text === '' && legacySeed.state.mouseTailHold === '[<35;10' && legacySeed.state.mouseTailHoldReleasable !== true,
    JSON.stringify(legacySeed.text),
  )
  const legacyDone = drive(legacySeed.state, [';10M'])
  check(
    '缺省（未注入证据）时 legacy hold 仍可续接为 mouse',
    legacyDone.text === '' && legacyDone.keys.some(key => key.kind === 'mouse'),
    JSON.stringify(legacyDone.text),
  )
}

// --- (g) 结构化注入契约（F-4）------------------------------------------------
// 端到端 App 渲染级注入回归留 v2（见 KNOWN-ISSUES.md）；本组把契约的结构面钉住：
// 注入点唯一、真源 getter 名、三态→布尔映射、字段名与只读透传。改名/退化/缺省
// 翻转必须红。
function injectionContract(): void {
  const repoRoot = new URL('..', import.meta.url)
  const appSource = readFileSync(new URL('src/ink/components/App.tsx', repoRoot), 'utf8')
  const inkSource = readFileSync(new URL('src/ink/ink.tsx', repoRoot), 'utf8')
  const parserSource = readFileSync(new URL('src/ink/parse-keypress.ts', repoRoot), 'utf8')

  const injectionLines = appSource.split('\n').filter(line => line.includes('mouseReportingActive:'))
  check(
    'F-4 App 注入点唯一（mouseReportingActive 赋值恰好 1 处）',
    injectionLines.length === 1,
    `count=${injectionLines.length}`,
  )
  const injection = injectionLines[0] ?? ''
  check(
    'F-4 注入映射三态→布尔（renderer?.isAltScreenMouseTracking === true）',
    injection.includes('isAltScreenMouseTracking') && /===\s*true/.test(injection),
    injection.trim(),
  )
  check(
    'F-4 ink.tsx getter 名 isAltScreenMouseTracking 唯一且返回 boolean',
    (inkSource.match(/get isAltScreenMouseTracking\(\): boolean/g) ?? []).length === 1,
  )
  check('F-4 KeyParseState 字段名为 mouseReportingActive 且可选 boolean', /mouseReportingActive\?: boolean/.test(parserSource))
  check(
    'F-4 解析器只读透传注入字段（newState 原样携带）',
    parserSource.includes('mouseReportingActive: prevState.mouseReportingActive'),
  )
}

const controlsOnly = process.argv.includes('--controls-only')
if (controlsOnly) {
  controls()
} else {
  matrix()
  nonContinuableRelease()
  antiSwallow()
  holdBounds()
  gatedColdAndExpiry()
  gatedHeads()
  gatedOverflow()
  gatedInjectionToggle()
  injectionContract()
  controls()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log(`\n${passed} assertion(s) passed`)
console.log(controlsOnly ? '\nCONTROL-OK' : '\nall mouse-report-fragment assertions passed')
