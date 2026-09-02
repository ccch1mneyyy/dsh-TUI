/**
 * verify-exit-gesture-protocol — #711（鼠标手势/协议闩锁状态机）× #701
 * （两相 shutdown 漏斗）交叉回归。
 *
 * 整合不变量：正常运行时 #711 的 gesture/protocol lifecycle 照常工作；
 * beginShutdown 之后一切 probe / reassert / reentry / frame producer 永久
 * 停止，stdin 只 drain，raw mode 保持到 settle 窗结束才 conclude。
 *
 *   Case A  鼠标 physical gesture active 时触发 exit：
 *           beginShutdown 后不得有 probe、不得有 ENABLE_MOUSE_TRACKING、
 *           不得有 DECRQM 写；cleanup 顺序 DISABLE_MOUSE → EXIT_ALT。
 *   Case B  protocol candidate（分片 SGR mouse report）active 时触发
 *           exit：shutdown 不等待 candidate 正常 completion（不发送补全
 *           字节也能完成退出）；shutdown 窗口内输入 drain-only；candidate
 *           补全字节在 shutdown 后到达不产生任何协议写（falling edge
 *           不得排空 pending probe）。
 *   Case C  存在 pendingAltScreenReentry / pendingProbe 时触发 exit：
 *           beginShutdown 永久取消这些 producer —— DISABLE_MOUSE 之后
 *           不得重新 reenter（ENTER_ALT）/ ENABLE。
 *   Case D  正常非退出 gesture：#711 的 release → batch-tail drain →
 *           probe 恢复行为保持，不被 shutdown gate 破坏。
 *
 * 共同断言（#701 §5 last-live App retention）：teardown 后
 * stdin.listenerCount('readable') === 0 —— 旧 runtime 不得吞下一个
 * mount 的输入。
 *
 * Run: node --import tsx/esm scripts/verify-exit-gesture-protocol.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  streamMod,
  ReactMod,
  xtermMod,
  uiMod,
  textMod,
  instancesMod,
  pluginMod,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/components/Text.js'),
  import('../src/ink/instances.js'),
  import('../src/dsh-adapter/plugin.js'),
])

const { finishExit } = pluginMod
const instances = instancesMod.default
const React = ReactMod
const { PassThrough, Writable } = streamMod
const { Terminal: XTerm } = xtermMod
const { render, AlternateScreen, useInput } = uiMod
const Text = textMod.default

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

const COLS = 100
const ROWS = 30
const ENTER_ALT = '\x1b[?1049h'
const EXIT_ALT = '\x1b[?1049l'
const ENABLE_MOUSE = '\x1b[?1000h'
const DISABLE_MOUSE = '\x1b[?1006l'
const DECRQM_1049 = '\x1b[?1049$p'

interface Scene {
  stdin: PassThrough & { isTTY: boolean; setRawMode(): unknown; ref(): unknown; unref(): unknown }
  stdout: { writes: string[] }
  instance: { unmount(): void }
  ink(): Record<string, unknown>
  app(): Record<string, unknown>
  press(c: number, r: number): void
  motion(c: number, r: number): void
  release(c: number, r: number): void
}

async function makeScene(marker: string): Promise<Scene> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    write(chunk: any, enc?: BufferEncoding | (() => void), cb?: () => void): boolean {
      writes.push(String(chunk))
      return super.write(chunk, enc as BufferEncoding, cb)
    }
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      term.write(String(chunk), cb)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) {
      cb()
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() {
      return this
    }
    ref() {
      return this
    }
    unref() {
      return this
    }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()

  function Scene() {
    useInput(() => {})
    return (
      <AlternateScreen>
        <Text>{marker}</Text>
      </AlternateScreen>
    )
  }
  const instance = await render(<Scene /> as never, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  // 等 AlternateScreen 的 insertion effect 跑完（ENTER_ALT + mouse enable）
  await new Promise(resolve => setTimeout(resolve, 120))
  return {
    stdin: stdin as never,
    stdout: { writes },
    instance: instance as never,
    ink: () => instances.get(stdout as never) as unknown as Record<string, unknown>,
    app: () =>
      (instances.get(stdout as never) as unknown as { app: Record<string, unknown> }).app,
    press: (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}M`),
    motion: (c: number, r: number) => stdin.write(`\x1b[<32;${c + 1};${r + 1}M`),
    release: (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}m`),
  }
}

/** 首个包含 needle 的写入下标；找不到返回 -1。 */
function firstIndexAfter(writes: string[], needle: string, from: number): number {
  for (let i = from; i < writes.length; i++) {
    if (writes[i]!.includes(needle)) return i
  }
  return -1
}

const ctx = { logger: { debug() {} } } as never

// ── Case A：physical gesture active 时触发 exit ──────────────────
{
  const scene = await makeScene('CASEA')
  const writes = scene.stdout.writes as string[]
  scene.press(10, 5)
  await new Promise(resolve => setTimeout(resolve, 80))
  const latched =
    (scene.ink().pointerGestureActive as boolean) === true
  check('A: press 后物理手势闩锁 active', latched)
  const beginAt = writes.length
  let doneA = false
  await finishExit(ctx, scene.instance as never, true, undefined, undefined, () => {
    doneA = true
  })
  check('A: finishExit 完成（done 执行）', doneA)
  const tail = writes.slice(beginAt).join('')
  check('A: beginShutdown 后无 ENABLE_MOUSE_TRACKING', !tail.includes(ENABLE_MOUSE))
  check('A: beginShutdown 后无 DECRQM write', !tail.includes(DECRQM_1049))
  const disableIdx = firstIndexAfter(writes, DISABLE_MOUSE, beginAt)
  const exitAltIdx = firstIndexAfter(writes, EXIT_ALT, beginAt)
  check(
    'A: cleanup 顺序 DISABLE_MOUSE → EXIT_ALT_SCREEN',
    disableIdx >= 0 && exitAltIdx >= 0 && disableIdx <= exitAltIdx,
    `disable@${disableIdx} exitAlt@${exitAltIdx}`,
  )
  check(
    'A: teardown 后 stdin readable listener 为 0',
    (scene.stdin as unknown as { listenerCount(e: string): number }).listenerCount('readable') === 0,
  )
}

// ── Case B：protocol candidate active 时触发 exit ────────────────
{
  const scene = await makeScene('CASEB')
  const writes = scene.stdout.writes as string[]
  // 分片 SGR mouse report：只写前缀，不发送补全字节
  scene.stdin.write('\x1b[<0;10')
  await new Promise(resolve => setTimeout(resolve, 50))
  const candidateLatched =
    (scene.ink().protocolCandidateActive as boolean) === true
  check('B: 分片前缀后 protocol candidate 闩锁 active', candidateLatched)
  const beginAt = writes.length
  const startedAt = Date.now()
  let doneB = false
  // 不发送 candidate 补全字节 —— shutdown 不得等待其正常 completion
  await finishExit(ctx, scene.instance as never, true, undefined, undefined, () => {
    doneB = true
  })
  const elapsedMs = Date.now() - startedAt
  check('B: shutdown 不等待 candidate completion 即完成', doneB)
  const tail = writes.slice(beginAt).join('')
  check('B: shutdown 窗口无 probe / ENABLE 写', !tail.includes(ENABLE_MOUSE) && !tail.includes(DECRQM_1049))
  // candidate 补全字节在 shutdown 后到达：drain-only，不解析、不产生写
  const writeCountAfter = writes.length
  scene.stdin.write(';5M') // 补全一次 press —— falling edge 不得排空任何 probe
  scene.stdin.write('\x1b[<0;11;6m') // release
  await new Promise(resolve => setTimeout(resolve, 120))
  check(
    'B: shutdown 后输入 drain-only，candidate falling edge 零写入',
    writes.length === writeCountAfter,
    `writes=${writes.length - writeCountAfter}`,
  )
  check(
    'B: teardown 后 stdin readable listener 为 0',
    (scene.stdin as unknown as { listenerCount(e: string): number }).listenerCount('readable') === 0,
  )
  void elapsedMs
}

// ── Case C：pendingAltScreenReentry / pendingProbe 时触发 exit ───
{
  const scene = await makeScene('CASEC')
  const writes = scene.stdout.writes as string[]
  const ink = scene.ink()
  // 直接置位：模拟 DECRPM 已确认 1049 reset + probe 被手势挡下
  ink.pendingAltScreenReentry = true
  ink.pendingProbeRequest = { skipMouseReassert: true }
  const beginAt = writes.length
  let doneC = false
  await finishExit(ctx, scene.instance as never, true, undefined, undefined, () => {
    doneC = true
  })
  check('C: finishExit 完成', doneC)
  const tail = writes.slice(beginAt).join('')
  const disableIdx = firstIndexAfter(writes, DISABLE_MOUSE, beginAt)
  const exitAltIdx = firstIndexAfter(writes, EXIT_ALT, beginAt)
  check(
    'C: cleanup 顺序 DISABLE_MOUSE → EXIT_ALT_SCREEN',
    disableIdx >= 0 && exitAltIdx >= 0 && disableIdx <= exitAltIdx,
  )
  check('C: DISABLE 后无 reenter（无 ENTER_ALT）', !tail.includes(ENTER_ALT))
  check('C: DISABLE 后无 ENABLE_MOUSE', !tail.includes(ENABLE_MOUSE))
  // beginShutdown 之后手动触发 drain（模拟迟到的 release tail）—— 仍不得写。
  // 注意 instances 条目已被 beginShutdown 删除：用 exit 前抓好的对象引用。
  const countAfter = writes.length
  const inkAny = ink as unknown as {
    drainReleaseTail: () => void
    drainAltScreenReentry: () => void
    drainPendingProbe: () => void
  }
  inkAny.drainReleaseTail()
  inkAny.drainAltScreenReentry()
  inkAny.drainPendingProbe()
  await new Promise(resolve => setTimeout(resolve, 80))
  check(
    'C: beginShutdown 永久取消 producer（迟到 drain 零写入）',
    writes.length === countAfter,
    `writes=${writes.length - countAfter}`,
  )
  check('C: pendingProbeRequest 被清除', ink.pendingProbeRequest === undefined)
  check(
    'C: teardown 后 stdin readable listener 为 0',
    (scene.stdin as unknown as { listenerCount(e: string): number }).listenerCount('readable') === 0,
  )
}

// ── Case D：正常非退出 gesture 的 #711 行为保持 ──────────────────
{
  const scene = await makeScene('CASED')
  const writes = scene.stdout.writes as string[]
  scene.press(8, 4)
  await new Promise(resolve => setTimeout(resolve, 60))
  const gestureStart = writes.length
  scene.motion(9, 4)
  scene.motion(10, 4)
  await new Promise(resolve => setTimeout(resolve, 60))
  const gestureTail = writes.slice(gestureStart).join('')
  check('D: 手势窗口零协议写入（#711 闩锁）', !gestureTail.includes(ENABLE_MOUSE) && !gestureTail.includes(DECRQM_1049))
  // 手势期间塞入一个 pending probe（模拟被挡下的探测请求）
  const ink = scene.ink() as { pendingProbeRequest?: { skipMouseReassert?: boolean } }
  ink.pendingProbeRequest = { skipMouseReassert: true }
  scene.release(10, 4)
  await new Promise(resolve => setTimeout(resolve, 150))
  // release → batch tail → drainPendingProbe：未被 shutdown gate 破坏，
  // probe 恢复（DECRQM 查询出现在 release 之后）
  const releaseIdx = (() => {
    for (let i = gestureStart; i < writes.length; i++) {
      // release 触发的重渲染/选择写不易辨别，用时间锚：直接找 drain 之后的
      // DECRQM —— 只要最终出现即证明 probe 管线活着
      if (writes[i]!.includes(DECRQM_1049)) return i
    }
    return -1
  })()
  check('D: release 后 pending probe 正常恢复（#711 行为未被 gate 破坏）', releaseIdx >= 0, `decrqm@${releaseIdx}`)
  check('D: 手势后 runtime 仍存活（未 latch）', (scene.ink().isUnmounted as boolean) !== true)
}

console.log(failures === 0 ? 'verify-exit-gesture-protocol: all checks passed' : `FAILURES: ${failures}`)
if (failures > 0) process.exit(1)
