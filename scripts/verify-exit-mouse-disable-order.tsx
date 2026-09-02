/**
 * 退出回显窗口回归：finishExit 必须把 150ms settle 窗放在 raw mode 仍
 * 持有时度过——先闩锁（beginShutdown：停掉一切输出生产者，但不恢复
 * cooked），再经 stdout 队列 barrier 排空预排队字节，有序写
 * DISABLE_MOUSE_TRACKING 与清理块，settle 后才在 finally 里
 * concludeShutdown 恢复 cooked+echo。且退出写必须永不抛、永不乱序：
 * 失败也不能跳过 cooked 恢复与 stdin 交接，barrier 超时也不能让
 * direct-fd 写越过仍在排队的迟到字节。
 *
 * 症状：SSH 链路卡顿/写阻塞时触发退出（含"自动退出"），冻结的 TUI 画面
 * 上、prompt 框里冒出 `^[[<35;130;47M` 之类 caret 记法的 SGR 鼠标报文
 * ——内核 canonical+ECHOCTL 把终端仍在发送的鼠标报文回显在停泊光标处。
 * writeSync 只证明字节进了内核 tty 缓冲，不代表远端终端已处理；若
 * cooked 恢复先于 settle 窗结束，窗口内到达的报文就被回显（#522）。
 *
 * 场景蒸馏（无需真 tty / 慢链路）：
 *   A. TTY 路径（fake stdout 持真实文件 fd，新形分相 runtime 携带自身
 *      stdout 与 raw 状态）：闩锁先于 DISABLE 落盘；settle 窗在 raw 态
 *      度过（drain 发生时 isRaw 仍为 true）；raw-off（conclude）时刻
 *      DISABLE 已在盘且距入口 ≥140ms（旧实现 detach 立即 raw-off，≈0
 *      必红）；事件序 begin→drain→conclude→handoff；两笔退出写全部走
 *      writeSync（零异步 stream write）。
 *   B. 无 fd 的 fake stdout（自定义 embedder / 回归替身）：回退有序
 *      stream 写，顺序约束不变——begin 先于 DISABLE、DISABLE 先于
 *      EXIT_ALT_SCREEN、字节完整、conclude/handoff/done 均执行。
 *   C. 写入全灭（无效 fd + _write 抛错）且 concludeShutdown 抛错
 *      （模拟 TTY 被撤销）：begin/conclude/handoff/done 仍全部被调用
 *      ——handoff 不被 conclude 的异常跳过（/update 子进程不能撞上
 *      残留 readable pump，#284/#307）。
 *   D. stdout 队列 barrier（显式 Promise gate 挂起预排队的
 *      ENABLE_MOUSE_TRACKING + 帧标记）：gate 未开前 DISABLE 绝不落盘
 *      （无时序假设——DISABLE 只在 barrier 放行后写出）；最终字节流
 *      ENABLE 在 DISABLE 前、帧标记在 EXIT_ALT_SCREEN 前，且
 *      EXIT_ALT_SCREEN 之后的尾部无 ENABLE/帧。
 *   E. barrier 超时（gate 1100ms 才开 > 1s 上限）：退出序列切换为有序
 *      stream 写，跟在迟到 ENABLE/帧之后——最终字节序仍然
 *      ENABLE→帧→DISABLE→EXIT_ALT_SCREEN，flush 等到全部落盘
 *      （旧实现 barrier 超时后 writeSync 越过队列，ENABLE 落在
 *      EXIT_ALT_SCREEN 之后）。
 *   F. stdout identity drift：render handle 的 runtime 属于流 A，而
 *      process.stdout 已被宿主换成流 B（B 还有挂起队列）——barrier 与
 *      全部清理写必须作用于 A，B 零字节、零等待。
 *
 * Run: node --import tsx/esm scripts/verify-exit-mouse-disable-order.tsx
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { finishExit } from '../src/dsh-adapter/plugin.js'
import instances from '../src/ink/instances.js'
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN } from '../src/ink/termio/dec.js'

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures += 1
}

const ctx = { logger: { debug() {} } } as never
const originalStdout = process.stdout
const swapStdout = (stream: NodeJS.WriteStream): void => {
  Object.defineProperty(process, 'stdout', {
    value: stream,
    configurable: true,
    writable: true,
    enumerable: true,
  })
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** _write 挂起在显式 gate 上的流；gate 开后先补放存量，再即时落盘。 */
class GatedFdStdout extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  fd: number
  gateOpen = false
  held: Array<{ text: string; cb: () => void }> = []
  constructor(fd: number) {
    super()
    this.fd = fd
  }
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    const text = String(chunk)
    if (this.gateOpen) {
      writeSync(this.fd, text)
      cb()
      return
    }
    this.held.push({ text, cb })
  }
  release(): void {
    this.gateOpen = true
    for (const { text, cb } of this.held.splice(0)) {
      writeSync(this.fd, text)
      cb()
    }
  }
}

// ── Case A：TTY 路径（文件 fd + 新形分相 runtime + raw 状态跟踪）───────
const traceFileA = join(tmpdir(), `dsh-tui-exit-order-a-${process.pid}.log`)
const fdA = openSync(traceFileA, 'w')
let asyncWritesA = 0
class FdStdout extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  fd: number = fdA
  _write(_chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    asyncWritesA += 1
    cb()
  }
}
const stdoutA = new FdStdout() as unknown as NodeJS.WriteStream

const eventsA: string[] = []
let rawOffAtA = -1
let isRawA = true
let isRawAtDrainA: boolean | undefined
let disableSeenAtBeginA: boolean | undefined
let disableSeenAtConcludeA: boolean | undefined
let unmountsA = 0
instances.set(stdoutA, {
  stdout: stdoutA,
  beginShutdown() {
    eventsA.push('begin')
    // 闩锁必须先于 DISABLE 落盘：先停输出生产者，再写禁用序列。
    disableSeenAtBeginA = readFileSync(traceFileA, 'utf8').includes(DISABLE_MOUSE_TRACKING)
  },
  concludeShutdown() {
    // raw-off 时刻：DISABLE 链必须已经在 fd 指向的文件里，且距入口已经
    // 度过了整个 settle 窗（旧实现 detach 立即 raw-off，rawOffAt≈0）。
    eventsA.push('conclude')
    rawOffAtA = Date.now()
    isRawA = false
    disableSeenAtConcludeA = readFileSync(traceFileA, 'utf8').includes(DISABLE_MOUSE_TRACKING)
  },
  detachStdinForHandoff() { eventsA.push('handoff') },
  drainStdin() {
    eventsA.push('drain')
    // settle 窗在 raw 态度过的直接证据：drain 发生时 cooked 尚未恢复。
    isRawAtDrainA = isRawA
  },
} as never)

swapStdout(stdoutA)
const t0A = Date.now()
let doneA = false
await finishExit(
  ctx,
  { unmount() { unmountsA += 1 } } as never,
  true,
  'hint-order',
  undefined,
  () => { doneA = true },
)
swapStdout(originalStdout)
instances.delete(stdoutA)
closeSync(fdA)

const traceA = readFileSync(traceFileA, 'utf8')
rmSync(traceFileA, { force: true })
check('A: 闩锁先于 DISABLE 落盘（begin 时文件尚无 DISABLE）', disableSeenAtBeginA === false)
check('A: settle 窗在 raw 态度过（drain 时 isRaw 仍为 true）', isRawAtDrainA === true)
check('A: raw-off 时 DISABLE 已落盘', disableSeenAtConcludeA === true)
check('A: raw-off 距入口 ≥140ms（settle 窗完整）',
  rawOffAtA >= 0 && rawOffAtA - t0A >= 140,
  rawOffAtA >= 0 ? `rawOffAt-t0=${rawOffAtA - t0A}ms` : 'conclude 未被调用')
check('A: 退出写全部走同步 fd 路径（零异步 stream write）', asyncWritesA === 0,
  asyncWritesA > 0 ? `异步写 ${asyncWritesA} 次` : '')
check('A: 清理块完整（EXIT_ALT_SCREEN + notice）', traceA.includes(EXIT_ALT_SCREEN) && traceA.includes('hint-order'))
check('A: 事件序 begin→drain→conclude→handoff，done 执行，不走 unmount 兜底',
  eventsA.join(',') === 'begin,drain,conclude,handoff' && doneA && unmountsA === 0,
  `事件序: ${eventsA.join(',') || '(空)'}`)

// ── Case B：无 fd 回退（有序 stream 写，顺序约束不变）──────────────────
const eventsB: string[] = []
const chunksB: string[] = []
class CapturingStdout extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    const text = String(chunk)
    chunksB.push(text)
    if (text.includes(DISABLE_MOUSE_TRACKING)) eventsB.push('disable')
    if (text.includes(EXIT_ALT_SCREEN)) eventsB.push('exit-alt')
    cb()
  }
}
const stdoutB = new CapturingStdout() as unknown as NodeJS.WriteStream
instances.set(stdoutB, {
  stdout: stdoutB,
  beginShutdown() { eventsB.push('begin') },
  concludeShutdown() { eventsB.push('conclude') },
  detachStdinForHandoff() { eventsB.push('handoff') },
  drainStdin() {},
} as never)

swapStdout(stdoutB)
let doneB = false
await finishExit(
  ctx,
  { unmount() {} } as never,
  // fullscreen=true：清理块带 EXIT_ALT_SCREEN，顺序断言才覆盖两笔写的先后。
  true,
  'hint-fallback',
  undefined,
  () => { doneB = true },
)
swapStdout(originalStdout)
instances.delete(stdoutB)

const joinedB = chunksB.join('')
const seqB = eventsB.join(',')
check('B: 回退路径事件序 begin→disable→exit-alt→conclude→handoff',
  seqB === 'begin,disable,exit-alt,conclude,handoff', `事件序: ${seqB || '(空)'}`)
check('B: 回退路径字节完整（DISABLE + notice），done 执行',
  joinedB.includes(DISABLE_MOUSE_TRACKING) && joinedB.includes('hint-fallback') && doneB)

// ── Case C：写入全灭 + conclude 抛错，handoff/done 仍必执行 ───────────
const eventsC: string[] = []
class ThrowingStdout extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  // 无效 fd：writeSync 必抛 EBADF → 落入有序 stream 路径；_write 再抛——
  // 两条写入路径全灭，finishExit 仍必须走完 conclude/handoff/done。
  fd = 9999
  _write(_chunk: unknown, _enc: BufferEncoding, _cb: () => void): void {
    throw new Error('simulated stream write failure')
  }
}
const stdoutC = new ThrowingStdout() as unknown as NodeJS.WriteStream
instances.set(stdoutC, {
  stdout: stdoutC,
  beginShutdown() { eventsC.push('begin') },
  concludeShutdown() {
    eventsC.push('conclude')
    // TTY 被撤销：raw-off 的 handleSetRawMode 写入抛错——不得跳过 handoff。
    throw new Error('simulated revoked tty')
  },
  detachStdinForHandoff() { eventsC.push('handoff') },
  drainStdin() {},
} as never)

swapStdout(stdoutC)
let doneC = false
let threwC = false
try {
  await finishExit(
    ctx,
    { unmount() {} } as never,
    false,
    'hint-throw',
    undefined,
    () => { doneC = true },
  )
} catch {
  threwC = true
}
swapStdout(originalStdout)
instances.delete(stdoutC)

check('C: 写入失败被吞（finishExit 正常 resolve）', !threwC)
check('C: 写入全灭 + conclude 抛错仍调用 begin/conclude/handoff/done',
  eventsC.join(',') === 'begin,conclude,handoff' && doneC,
  `事件序: ${eventsC.join(',') || '(空)'}, done=${doneC}`)

// ── Case D：barrier（Promise gate 挂起预排队 ENABLE+帧，无时序假设）────
const traceFileD = join(tmpdir(), `dsh-tui-exit-order-d-${process.pid}.log`)
const fdD = openSync(traceFileD, 'w')
const FRAME_MARKER = 'QUEUED-FRAME-MARKER'
const stdoutD = new GatedFdStdout(fdD) as unknown as NodeJS.WriteStream
let disableSeenAtConcludeD: boolean | undefined
instances.set(stdoutD, {
  stdout: stdoutD,
  beginShutdown() {},
  concludeShutdown() {
    disableSeenAtConcludeD = readFileSync(traceFileD, 'utf8').includes(DISABLE_MOUSE_TRACKING)
  },
  detachStdinForHandoff() {},
  drainStdin() {},
} as never)

swapStdout(stdoutD)
// 闩锁前排入：一笔 ENABLE（自愈探针的最后一笔）+ 一帧渲染。
stdoutD.write(ENABLE_MOUSE_TRACKING)
stdoutD.write(FRAME_MARKER)
let doneD = false
const finishD = finishExit(
  ctx,
  { unmount() {} } as never,
  true,
  'hint-barrier',
  undefined,
  () => { doneD = true },
)
// 让 finishExit 进入 barrier 等待（latch 同步完成、poll 定时器已排上）；
// 此处无 wall-clock 假设：DISABLE 只在 barrier 放行后写出，gate 未开时
// 无论调度快慢它都不可能在盘。
await tick()
await tick()
const disableBeforeGateD = readFileSync(traceFileD, 'utf8').includes(DISABLE_MOUSE_TRACKING)
;(stdoutD as unknown as GatedFdStdout).release()
await finishD
swapStdout(originalStdout)
instances.delete(stdoutD)
closeSync(fdD)

const traceD = readFileSync(traceFileD, 'utf8')
rmSync(traceFileD, { force: true })
const idxEnableD = traceD.indexOf(ENABLE_MOUSE_TRACKING)
const idxDisableD = traceD.indexOf(DISABLE_MOUSE_TRACKING)
const idxExitAltD = traceD.indexOf(EXIT_ALT_SCREEN)
const tailD = idxExitAltD === -1 ? '' : traceD.slice(idxExitAltD)
check('D: barrier 等待队列排空（gate 未开时 DISABLE 未落盘）', !disableBeforeGateD)
check('D: 预排队 ENABLE 落在 DISABLE 之前（最终鼠标态是 DISABLE）',
  idxEnableD !== -1 && idxDisableD !== -1 && idxEnableD < idxDisableD,
  `enable@${idxEnableD}, disable@${idxDisableD}`)
check('D: 预排队帧落在 EXIT_ALT_SCREEN 之前，且尾部无 ENABLE/帧（主屏零污染）',
  traceD.includes(FRAME_MARKER) && traceD.indexOf(FRAME_MARKER) < idxExitAltD
  && !tailD.includes(ENABLE_MOUSE_TRACKING) && !tailD.includes(FRAME_MARKER))
check('D: raw-off 时 DISABLE 已落盘，done 执行', disableSeenAtConcludeD === true && doneD)

// ── Case E：barrier 超时（gate 1100ms 才开）→ 有序 stream 写保序 ──────
const traceFileE = join(tmpdir(), `dsh-tui-exit-order-e-${process.pid}.log`)
const fdE = openSync(traceFileE, 'w')
const stdoutE = new GatedFdStdout(fdE) as unknown as NodeJS.WriteStream
instances.set(stdoutE, {
  stdout: stdoutE,
  beginShutdown() {},
  concludeShutdown() {},
  detachStdinForHandoff() {},
  drainStdin() {},
} as never)

swapStdout(stdoutE)
stdoutE.write(ENABLE_MOUSE_TRACKING)
stdoutE.write(FRAME_MARKER)
// gate 在 barrier 1s 上限之后才开：barrier 必超时，退出序列必须切到有序
// stream 路径跟在迟到字节之后，而不是 writeSync 越过队列。
const gateTimerE = setTimeout(() => (stdoutE as unknown as GatedFdStdout).release(), 1100)
const t0E = Date.now()
let doneE = false
await finishExit(
  ctx,
  { unmount() {} } as never,
  true,
  'hint-timeout',
  undefined,
  () => { doneE = true },
)
clearTimeout(gateTimerE)
swapStdout(originalStdout)
instances.delete(stdoutE)
closeSync(fdE)
const elapsedE = Date.now() - t0E

const traceE = readFileSync(traceFileE, 'utf8')
rmSync(traceFileE, { force: true })
const idxEnableE = traceE.indexOf(ENABLE_MOUSE_TRACKING)
const idxFrameE = traceE.indexOf(FRAME_MARKER)
const idxDisableE = traceE.indexOf(DISABLE_MOUSE_TRACKING)
const idxExitAltE = traceE.indexOf(EXIT_ALT_SCREEN)
const tailE = idxExitAltE === -1 ? '' : traceE.slice(idxExitAltE)
check('E: barrier 超时后走有序 stream 路径（耗时 ≥1s 上限）', elapsedE >= 1000, `elapsed=${elapsedE}ms`)
check('E: 迟到 ENABLE/帧仍落在 DISABLE 之前（保序，无交错）',
  idxEnableE !== -1 && idxFrameE !== -1 && idxDisableE !== -1
  && idxEnableE < idxDisableE && idxFrameE < idxDisableE,
  `enable@${idxEnableE}, frame@${idxFrameE}, disable@${idxDisableE}`)
check('E: EXIT_ALT_SCREEN 完整落盘且尾部无 ENABLE/帧',
  idxExitAltE !== -1 && idxExitAltE > idxDisableE
  && !tailE.includes(ENABLE_MOUSE_TRACKING) && !tailE.includes(FRAME_MARKER))
check('E: flush 等到全部字节落盘，done 执行', traceE.includes('hint-timeout') && doneE)

// ── Case F：stdout identity drift（runtime 属流 A，process.stdout 是 B）─
const traceFileFA = join(tmpdir(), `dsh-tui-exit-order-fa-${process.pid}.log`)
const traceFileFB = join(tmpdir(), `dsh-tui-exit-order-fb-${process.pid}.log`)
const fdFA = openSync(traceFileFA, 'w')
const fdFB = openSync(traceFileFB, 'w')
const streamFA = new GatedFdStdout(fdFA) as unknown as NodeJS.WriteStream
streamFA.release() // A 队列畅通
const streamFB = new GatedFdStdout(fdFB) as unknown as NodeJS.WriteStream
// B 挂着一笔永远不放行的写：若 barrier 错轮询 B，finishExit 会白等 1s。
streamFB.write('WEDGED-ON-B')
const eventsF: string[] = []
instances.set(streamFA, {
  stdout: streamFA,
  beginShutdown() { eventsF.push('begin') },
  concludeShutdown() { eventsF.push('conclude') },
  detachStdinForHandoff() { eventsF.push('handoff') },
  drainStdin() {},
} as never)

swapStdout(streamFB)
const t0F = Date.now()
let doneF = false
await finishExit(
  ctx,
  // render handle 即 runtime 的载体（instances map 按 B 查找必 miss）。
  instances.get(streamFA) as never,
  true,
  'hint-drift',
  undefined,
  () => { doneF = true },
)
const elapsedF = Date.now() - t0F
swapStdout(originalStdout)
instances.delete(streamFA)
;(streamFB as unknown as GatedFdStdout).release()
closeSync(fdFA)
closeSync(fdFB)

const traceFA = readFileSync(traceFileFA, 'utf8')
const traceFB = readFileSync(traceFileFB, 'utf8')
rmSync(traceFileFA, { force: true })
rmSync(traceFileFB, { force: true })
check('F: 清理写作用于 runtime 所属流 A（DISABLE/EXIT_ALT/notice 齐全）',
  traceFA.includes(DISABLE_MOUSE_TRACKING) && traceFA.includes(EXIT_ALT_SCREEN) && traceFA.includes('hint-drift'))
check('F: 替换后的 process.stdout（B）零退出字节', !traceFB.includes(DISABLE_MOUSE_TRACKING) && !traceFB.includes(EXIT_ALT_SCREEN),
  traceFB.length > 0 ? `B 收到 ${traceFB.length} 字节` : '')
check('F: barrier 不错等 B 的挂起队列（无 1s 白等）', elapsedF < 900, `elapsed=${elapsedF}ms`)
check('F: 事件序 begin→conclude→handoff，done 执行',
  eventsF.join(',') === 'begin,conclude,handoff' && doneF, `事件序: ${eventsF.join(',') || '(空)'}`)

console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
