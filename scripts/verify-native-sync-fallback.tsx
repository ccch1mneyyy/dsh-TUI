/** #1818: keep atomic frame markers on local Windows TTYs without WT_SESSION. */
import './lib/fake-home.mjs'
import { spawnSync } from 'node:child_process'

const cases = ['known', 'unknown-local', 'tmux', 'zellij', 'ssh', 'ssh-tty', 'pipe', 'linux', 'inline', 'known-remote'] as const
const selected = process.argv.indexOf('--case')
if (selected < 0) {
  let failures = 0
  for (const name of cases) {
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', process.argv[1]!, '--case', name],
      { env: process.env, encoding: 'utf8', timeout: 15_000, windowsHide: true })
    process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '')
    if (child.status !== 0) failures++
    if (child.error || child.signal) { console.error(child.error?.message ?? child.signal); break }
  }
  console.log(`verify-native-sync-fallback: ${cases.length} cases, ${failures} failed`)
  if (failures) process.exitCode = 1
} else {
  const name = process.argv[selected + 1] as typeof cases[number]
  if (!cases.includes(name)) throw new Error('Unknown case')
  process.env.DSH_TUI_LANG = 'en'
  process.env.TERM = 'xterm-256color'
  for (const key of ['TERM_PROGRAM', 'WT_SESSION', 'KITTY_WINDOW_ID', 'VTE_VERSION', 'ZED_TERM', 'TERMINAL_EMULATOR', 'TMUX', 'ZELLIJ', 'SSH_CONNECTION', 'SSH_TTY', 'DSH_TUI_RENDER_LOG', 'DSH_TUI_DEBUG_MOUSE']) delete process.env[key]
  if (name === 'known' || name === 'known-remote') process.env.WT_SESSION = 'synthetic-known-terminal'
  if (name === 'tmux') process.env.TMUX = 'synthetic-multiplexer'
  if (name === 'zellij') process.env.ZELLIJ = 'synthetic-multiplexer'
  if (name === 'ssh' || name === 'known-remote') process.env.SSH_CONNECTION = 'synthetic-ssh-connection'
  if (name === 'ssh-tty') process.env.SSH_TTY = 'synthetic-remote-tty'
  const [React, { PassThrough, Writable }, { Terminal }, ui, { isDecstbmSafe }, { settled, sleep }] = await Promise.all([
    import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
    import('../src/ink/terminal.js'), import('./lib/term-test.mjs'),
  ])
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  // In-memory platform/TTY policy cases, not claims about the actual OS.
  // Modules load on the real OS before changing the constructor's platform gate.
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: name === 'linux' ? 'linux' : 'win32' })
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  class Input extends PassThrough {
    isTTY = true
    isRaw = false
    setRawMode(value: boolean): this { this.isRaw = value; return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdin = new Input()
  const written: string[] = []
  const timers: ReturnType<typeof setTimeout>[] = []
  class Output extends Writable {
    columns = 40
    rows = 10
    isTTY = name !== 'pipe'
    _write(data: unknown, _encoding: BufferEncoding, done: () => void): void {
      const text = String(data); written.push(text)
      if (text.includes('\x1b[c')) timers.push(setTimeout(() => stdin.write('\x1b[?1;2c'), 0))
      terminal.write(text, done)
    }
  }
  const stdout = new Output()
  const stderr = new Writable({ write(_data, _encoding, done) { done() } })
  const inputs: string[] = []
  let advance: (() => void) | undefined
  function Scene(): React.ReactNode {
    const [phase, setPhase] = React.useState(false)
    advance = () => setPhase(true)
    ui.useInput(value => { inputs.push(value) })
    const text = <ui.Text>{phase ? 'BBBBB' : 'AAAAA'}</ui.Text>
    return name === 'inline' ? text : <ui.AlternateScreen>{text}</ui.AlternateScreen>
  }
  let failures = 0
  const check = (label: string, ok: boolean): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${label}`)
    if (!ok) failures++
  }
  const screen = (): string => Array.from({ length: 10 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  const instance = await ui.render(<Scene />, { stdin: stdin as never, stdout: stdout as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false })
  const exited = instance.waitUntilExit()
  const expectedSync = ['known', 'unknown-local', 'inline', 'known-remote'].includes(name)
  try {
    if (!await settled(() => screen().includes('AAAAA'))) throw new Error('Initial actual frame missing')
    stdin.write('z')
    check('ordinary input remains intact', await settled(() => inputs.join('') === 'z'))
    advance?.()
    check('next frame actually paints BBBBB', await settled(() => screen().includes('BBBBB')))
    const frames = written.filter(text => text.includes('BBBBB'))
    const wrapped = frames.length > 0 && frames.every(text => text.startsWith('\x1b[?2026h') && text.endsWith('\x1b[?2026l'))
    check('painted frame grouping matches the explicit policy', wrapped === expectedSync)
    check('global hardware-scroll eligibility is unchanged', isDecstbmSafe() === ['known', 'known-remote'].includes(name))
    // 固定窗:探针 — marker fallback must not create a capability query or polling traffic.
    await sleep(80)
    check('no DEC2026 capability query is sent', !written.join('').includes('\x1b[?2026$p'))
    console.log(`FRAME ${JSON.stringify({ name, wrapped, bytes: frames.map(text => Buffer.byteLength(text)), screen: screen().trimEnd(), simulatedPlatformGate: true })}`)
  } finally {
    await instance.unmount(); await exited
    for (const timer of timers) clearTimeout(timer)
    Object.defineProperty(process, 'platform', originalPlatform)
    terminal.dispose(); stdin.destroy(); stdout.destroy(); stderr.destroy()
  }
  check('raw mode restored', stdin.isRaw === false)
  console.log(`RESULT ${JSON.stringify({ name, failures, actualOs: process.platform, simulatedPlatformGate: true })}`)
  if (failures) process.exitCode = 1
}
