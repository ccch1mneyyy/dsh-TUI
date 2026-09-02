/**
 * 退出清理之后鼠标追踪不得再被重新打开（#522 / #507 / #492 的确定性蒸馏）。
 *
 * 症状：/exit 回到 shell 后，点击/移动鼠标冒出 `ESC[<0;12;5M` 之类 SGR 序列
 * 被 shell 原样回显——SGR 鼠标模式是终端会话状态，进程退出不会自动重置；
 * 残留 = 退出清理（DISABLE_MOUSE_TRACKING）之后仍有任何代码写出 ENABLE。
 *
 * 场景蒸馏（无需时序竞态）：
 *   1. 挂载 AlternateScreen + Probe（altScreenActive=true、mouseTracking=
 *      true——probe 的全部前置条件就位；Probe 消费 useInput 与
 *      TerminalWriteContext，与 PromptInput 的异步 OSC 52 clipboard 回调
 *      持有的是同一支 writeRaw）；
 *   2. 先证明输入派发管线已接线（闩锁前注入 'a' 必被 useInput 收到）；
 *   3. 模拟退出漏斗 finishExit 的同序两步：beginShutdown()（置
 *      isUnmounted 闩锁、停输出生产者，raw mode 仍持有）→ 写出
 *      DISABLE_MOUSE_TRACKING（cooked 恢复属于最后的 concludeShutdown）；
 *   4. 闩锁后断言核心契约：isRaw 仍为 true（settle 窗在 raw 态度过）、
 *      注入输入只 drain 不派发、经 context 的 writeRaw 零字节落盘；
 *   5. 过 250ms 节流窗后调 probeAltScreenHealth()——对应退出前窗口期
 *      （settle 窗 + disposeRootAndThen 5s 兜底）内任何按键/鼠标
 *      输入触发的健康探针；断言清理序列之后不得再出现任何鼠标 ENABLE
 *      （?1000h/1002h/1003h/1006h）。未修复的 probe 不检查 isUnmounted，
 *      每次必红；
 *   6. concludeShutdown() 之后断言 isRaw === false（cooked 恢复才在
 *      finally 里发生）。
 *
 * Run: node --import tsx/esm scripts/verify-exit-mouse-residue.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, useInput, AlternateScreen, Text },
  { default: instances },
  { TerminalQuerier, decrqm },
  { TerminalWriteContext },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/instances.js'),
  import('../src/ink/terminal-querier.js'),
  import('../src/ink/useTerminalNotification.js'),
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
  isRaw = false
  setRawMode(value: boolean): this {
    this.isRaw = value
    return this
  }
  ref(): this { return this }
  unref(): this { return this }
}
const stdout = new FakeStdout() as unknown as NodeJS.WriteStream
const stdin = new FakeStdin() as unknown as NodeJS.ReadStream
const flush = (): Promise<void> => lastFlushed

const MOUSE_ENABLE = /\x1b\[\?100[0236]h/
const MOUSE_DISABLE = /\x1b\[\?100[0236]l/

// ── Probe：useInput 记录派发到的输入；经 TerminalWriteContext 捕获
// writeRaw——即 PromptInput 异步 OSC 52 clipboard 回调持有的同一支
// （ink.tsx 以 Ink.writeRaw 为 provider 值，闩锁门在那里）。
const received: string[] = []
let rawWriter: ((data: string) => void) | null = null
const Probe = (): React.ReactElement => {
  useInput(input => { received.push(input) })
  const writeRaw = React.useContext(TerminalWriteContext)
  React.useEffect(() => { rawWriter = writeRaw }, [writeRaw])
  return <Text>exit-residue probe</Text>
}

await render(
  <AlternateScreen>
    <Probe />
  </AlternateScreen>,
  { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
)

/** 三条防线的最小驱动面（避免 as any，按仓库 unknown 收窄惯例）。 */
type InkDriver = {
  detachForShutdown(): void
  /** 退出分相：begin = 闩锁+停生产者（raw 仍持有）；conclude = raw-off。 */
  beginShutdown(): void
  concludeShutdown(): void
  probeAltScreenHealth(): void
  reassertTerminalModes(includeAltScreen?: boolean): void
  app?: { querier?: TerminalQuerier }
}
const ink = instances.get(stdout) as unknown as InkDriver | undefined
check('Ink 实例存在（挂载成功）', ink !== undefined)
if (!ink) process.exit(1)
await flush()
await sleep(50)

// ── 前置证据：闩锁前输入派发管线已接线（否则闩锁后的"不派发"断言无意义）。
stdin.write('a')
await sleep(30)
check('闩锁前 useInput 正常派发（管线已接线）', received.join('') === 'a',
  `received: ${JSON.stringify(received)}`)
check('挂载后 stdin 处于 raw mode（useInput 的 layout effect 已生效）', stdin.isRaw === true)

// ── 模拟退出漏斗 finishExit（src/dsh-adapter/plugin.ts）：先 beginShutdown
// 闩锁（置 isUnmounted、停输出生产者，raw mode 仍持有），cleanup 序列在
// raw 态下写出——与真实退出同序；cooked 恢复是最后的 concludeShutdown。
ink.beginShutdown()
check('beginShutdown 之后 raw mode 仍持有（settle 窗的前提）', stdin.isRaw === true)
stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l')
await flush()

const cut = bytes.length
const cleanupTail = bytes.slice(0, cut).join('')
check('退出清理序列已写出（DISABLE 到达终端）', MOUSE_DISABLE.test(cleanupTail))

// ── 闩锁后的写入/输入闸门（settle 窗内不得有任何字节再落盘）：
//   · 注入按键与 SGR 鼠标报文——handleReadable 闩锁后只 drain 不派发，
//     useInput 不得再收到（否则会触发新的 clipboard/探针动作）；
//   · 经 context 拿到的 writeRaw 写 OSC 52——Ink.writeRaw 的闩锁门必须
//     丢弃它（模拟 PromptInput copySelectionNoClear 的异步回调迟到）。
stdin.write('b')
stdin.write('\x1b[<35;1;1M')
rawWriter?.('\x1b]52;c;QUJDRA==\x07')
await sleep(30)

// ── 250ms 节流窗过去，退出前窗口期的输入派发触发健康探针。
await sleep(300)
ink.probeAltScreenHealth()
await flush()
await sleep(50)

const tail = bytes.slice(cut).join('')
check('闩锁后输入只 drain 不派发（useInput 零新增）', received.join('') === 'a',
  received.length > 1 ? `多收到: ${JSON.stringify(received.slice(1))}` : '')
check('闩锁后 writeRaw 零字节（OSC 52 迟到回调被门丢弃）', !tail.includes('\x1b]52'),
  tail.includes('\x1b]52') ? `泄漏: ${JSON.stringify(tail.slice(0, 40))}` : '')
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
// beginShutdown 链（ink → App.beginShutdown）已 dispose querier；绕过
// probe 直接打 querier，模拟退出窗口期任何残余调用方。
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

// ── 收尾：cooked 恢复/末次 drain（真实漏斗在 settle 窗之后的 finally 里做）。
ink.concludeShutdown()
check('concludeShutdown 之后 raw mode 已释放（cooked 恢复）', stdin.isRaw === false)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
