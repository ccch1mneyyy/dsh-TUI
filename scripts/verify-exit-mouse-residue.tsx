/**
 * 退出清理之后鼠标追踪不得再被重新打开（#522 / #507 / #492 的确定性蒸馏）。
 *
 * 症状：/exit 回到 shell 后，点击/移动鼠标冒出 `ESC[<0;12;5M` 之类 SGR 序列
 * 被 shell 原样回显——SGR 鼠标模式是终端会话状态，进程退出不会自动重置；
 * 残留 = 退出清理（DISABLE_MOUSE_TRACKING）之后仍有任何代码写出 ENABLE。
 *
 * 场景蒸馏（无需时序竞态）：
 *   1. 挂载 AlternateScreen（altScreenActive=true，mouseTracking=true——
 *      probe 的全部前置条件就位）；
 *   2. 模拟退出漏斗 finishExit 的同序两步：detachForShutdown()（置
 *      isUnmounted）→ 写出 DISABLE_MOUSE_TRACKING；
 *   3. 过 250ms 节流窗后调 probeAltScreenHealth()——对应退出前窗口期
 *      （writeStream 1s + disposeRootAndThen 5s 兜底）内任何按键/鼠标
 *      输入触发的健康探针；
 *   4. 断言：清理序列之后不得再出现任何鼠标 ENABLE（?1000h/1002h/1003h/
 *      1006h）。未修复的 probe 不检查 isUnmounted，每次必红。
 *
 * Run: node --import tsx/esm scripts/verify-exit-mouse-residue.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Text }, { default: instances }, { TerminalQuerier, decrqm }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/ink/instances.js'),
    import('../src/ink/terminal-querier.js'),
  ])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const COLS = 40
const ROWS = 10
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })

// 捕获写给终端的全部字节——断言的对象就是这条字节流的顺序。
const bytes: string[] = []
let lastFlushed: Promise<void> = Promise.resolve()
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    const text = String(chunk)
    bytes.push(text)
    lastFlushed = new Promise<void>(res => term.write(text, () => { cb(); res() }))
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const stdout = new FakeStdout() as unknown as NodeJS.WriteStream
const stdin = new FakeStdin() as unknown as NodeJS.ReadStream
const flush = (): Promise<void> => lastFlushed

const MOUSE_ENABLE = /\x1b\[\?100[0236]h/
const MOUSE_DISABLE = /\x1b\[\?100[0236]l/

await render(
  <AlternateScreen>
    <Text>exit-residue probe</Text>
  </AlternateScreen>,
  { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
)

/** 三条防线的最小驱动面（避免 as any，按仓库 unknown 收窄惯例）。 */
type InkDriver = {
  detachForShutdown(): void
  probeAltScreenHealth(): void
  reassertTerminalModes(includeAltScreen?: boolean): void
  app?: { querier?: TerminalQuerier }
}
const ink = instances.get(stdout) as unknown as InkDriver | undefined
check('Ink 实例存在（挂载成功）', ink !== undefined)
if (!ink) process.exit(1)
await flush()
await sleep(50)

// ── 模拟退出漏斗 finishExit（src/dsh-adapter/plugin.ts）：先 detach（置
// isUnmounted），cleanup 序列随后写出——与真实退出同序。detach 置位后，
// 窗口期一切终端写入都不应再发生。
ink.detachForShutdown()
stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l')
await flush()

const cut = bytes.length
const cleanupTail = bytes.slice(0, cut).join('')
check('退出清理序列已写出（DISABLE 到达终端）', MOUSE_DISABLE.test(cleanupTail))

// ── 250ms 节流窗过去，退出前窗口期的输入派发触发健康探针。
await sleep(300)
ink.probeAltScreenHealth()
await flush()
await sleep(50)

const tail = bytes.slice(cut).join('')
check('清理之后无任何鼠标 ENABLE 残留（probe 尊重 isUnmounted）', !MOUSE_ENABLE.test(tail),
  tail.match(MOUSE_ENABLE) ? `残留序列: ${JSON.stringify(tail.match(MOUSE_ENABLE))}` : '')

// ── 第二刀防线：stdin-resume 路径的重断言同样不得在退出后碰终端
// （kitty keyboard / focus reporting 重开 = #492 的 extended-key 残留）。
const cut2 = bytes.length
ink.reassertTerminalModes(true)
await flush()
await sleep(50)
const tail2 = bytes.slice(cut2).join('')
check('退出后 reassertTerminalModes 零字节写出（kitty keyboard 不重开）', tail2 === '',
  tail2 ? `写出了 ${JSON.stringify(tail2.slice(0, 40))}` : '')

// ── 第三刀防线：dispose 之后的 querier 不得再发查询、不得再拉回 raw mode
// （#507 的 DECRPM/DA1 回复泄漏 shell + ?2004h raw mode 重开）。
// detach 链（ink → App.detachForShutdown）已 dispose querier；绕过 probe
// 直接打 querier，模拟退出窗口期任何残余调用方。
const cut3 = bytes.length
const querier: TerminalQuerier | undefined = ink.app?.querier
check('querier 存在且已被 detach 链持有', querier !== undefined)
if (querier) {
  void querier.send(decrqm(1049))
  void querier.flush()
  await flush()
  await sleep(50)
  const tail3 = bytes.slice(cut3).join('')
  const QUERY_BYTES = /\x1b\[\?1049\$p|\x1b\[c|\x1b\[\?2004h/
  check('dispose 后 querier 零查询字节 / 不拉回 raw mode', !QUERY_BYTES.test(tail3),
    tail3 ? `写出了 ${JSON.stringify(tail3.slice(0, 40))}` : '')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
