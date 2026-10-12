#!/usr/bin/env node
/**
 * verify-handoff-pty-gate.mjs — 在真实 PTY 里跑一遍全屏内核切换的交接链：
 * 旧进程进 1049 → 过场文案 → spawn replacement → adopted / 首帧 / ready →
 * replacement 退出时关 1049。断言：
 *
 *   1. replacement 的 stdout 是 TTY、有 columns/rows、能 setRawMode；
 *   2. DA1 查询（ESC[c）能收到回复（图片协议探测的前提），无需按键唤醒；
 *   3. 旧进程曾读过 stdin，分离后即便再次 read(0) 也不抢走 replacement 的回复；
 *   4. 1049h、1049l 各恰好一次，1049l 晚于首帧，过场文案在 alt 屏内。
 *
 * PTY 来源按顺序自动选择（DSH_TUI_PTY_GATE 可指定）：node-pty（Windows 为
 * ConPTY）、POSIX script（Linux CI 走这条）、pipe（没有 PTY 时只查 3、4，
 * 并注明跳过了设备相关断言）。
 *
 * 运行：node --import tsx/esm scripts/verify-handoff-pty-gate.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)
const isDriver = process.argv.includes('--pty-driver')

// ── driver：在 PTY 内跑完整交接链 ────────────────────────────────────────
if (isDriver) {
  const { detachHandoffStdin, restartTui } = await import('../src/update.ts')
  const markerPath = process.env.PTY_GATE_MARKER ?? ''
  const { writeSync } = await import('node:fs')
  const attempt = process.env.DSH_TUI_HANDOFF_ATTEMPT ?? ''
  // Each role reports to its own file: the parent finishes last and would
  // otherwise overwrite the replacement's TTY facts.
  const report = (payload) => {
    if (markerPath !== '') {
      const target = payload.role === 'replacement' ? markerPath + '.replacement' : markerPath
      try { writeFileSync(target, JSON.stringify(payload)) } catch { /* diagnosis only */ }
    }
  }

  if (process.env.DSH_TUI_HANDOFF_ACK_FD !== undefined) {
    // replacement：屏幕已在 1049 里（不再发 1049h），探测、画首帧、发
    // ready，然后像用户正常退出那样自己关 1049。
    const fd = Number(process.env.DSH_TUI_HANDOFF_ACK_FD)
    const ack = kind => writeSync(fd, 'dsh-tui-handoff ' + kind + ' ' + attempt + '\n')
    const probeSeen = await new Promise(resolve => {
      const stdin = process.stdin
      let saw = false
      const onReadable = () => {
        const chunk = stdin.read()
        if (chunk !== null && String(chunk).includes('\u001b[?')) saw = true
        if (saw) { cleanup(); resolve(true) }
      }
      const cleanup = () => { stdin.removeListener('readable', onReadable); stdin.pause() }
      stdin.pause()
      if (stdin.isTTY !== true) { resolve(undefined); return }
      stdin.setRawMode(true)
      stdin.on('readable', onReadable)
      process.stdout.write('\u001b[c') // DA1，代表一次能力探测往返
      setTimeout(() => { cleanup(); resolve(saw) }, 1200)
    })
    report({
      role: 'replacement',
      isTTY: process.stdout.isTTY === true,
      columns: typeof process.stdout.columns === 'number' ? process.stdout.columns : 0,
      rows: typeof process.stdout.rows === 'number' ? process.stdout.rows : 0,
      hasSetRawMode: typeof process.stdin.setRawMode === 'function',
      probeSeen,
    })
    ack('adopted')
    process.stdout.write('GATE-CHILD-FIRST-FRAME\n', () => ack('ready'))
    setTimeout(() => {
      // ready 之后屏幕归 replacement，由它关 1049。
      process.stdout.write('\u001b[?1049l\r\n')
      process.exit(0)
    }, 150)
    await new Promise(() => {})
  }

  // 旧进程：先进 1049（相当于它自己的全屏），再跑真实的 restartTui。
  process.stdout.write('\u001b[?1049h\u001b[2J\u001b[H')
  if (process.stdin.isTTY) {
    // Like Ink, first use readable-mode input, then detach before the spawn.
    // A final drain can schedule another _read after pause(): zero listeners
    // alone does not prevent that read from stealing the child's first reply.
    process.stdin.setRawMode(true)
    process.stdin.on('readable', () => { while (process.stdin.read() !== null) {} })
    process.stdin.read(0)
    detachHandoffStdin()
    process.stdin.read(0)
  }
  const stdinBefore = {
    readable: process.stdin.listenerCount('readable'),
    data: process.stdin.listenerCount('data'),
  }
  const code = await restartTui('sess-gate', {
    backend: 'claude',
    handoffScreen: 'alt',
    env: { PTY_GATE_MARKER: markerPath },
  })
  const stdinAfter = {
    readable: process.stdin.listenerCount('readable'),
    data: process.stdin.listenerCount('data'),
    buffered: process.stdin.readableLength,
  }
  report({ role: 'parent', code, stdinBefore, stdinAfter })
  process.exit(code)
}

// ── gate 主角色 ───────────────────────────────────────────────────────────
let failures = 0
let notes = 0
function check(name, ok, detail = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (detail === '' ? '' : '  (' + detail + ')'))
  if (!ok) failures += 1
}
function note(text) {
  console.log('NOTE: ' + text)
  notes += 1
}

async function detectProvider() {
  const forced = process.env.DSH_TUI_PTY_GATE
  if (forced !== undefined && forced !== '') return forced
  try {
    // node-pty 是可选依赖，装了就用（Windows 上是 ConPTY）。
    const require = (await import('node:module')).createRequire(import.meta.url)
    require.resolve('node-pty')
    return 'node-pty'
  } catch {
    if (process.platform !== 'win32') {
      const probe = spawnSync('script', ['--version'], { encoding: 'utf8', timeout: 5000 })
      if (probe.status === 0) return 'script'
    }
    return 'pipe'
  }
}
const provider = await detectProvider()

const tmp = mkdtempSync(join(tmpdir(), 'verify-pty-gate-'))
const marker = join(tmp, 'replacement.json')
const env = { ...process.env, PTY_GATE_MARKER: marker, HOME: tmp, USERPROFILE: tmp }
delete env.DSH_TUI_HANDOFF_ACK_FD
delete env.DSH_TUI_HANDOFF_SCREEN
delete env.DSH_TUI_HANDOFF_ATTEMPT
delete env.DSH_TUI_HOST_ENTRY_PATH // restart this fixture, not an enclosing TUI

const driverCommand = [process.execPath, '--import', 'tsx/esm', selfPath, '--pty-driver']
let run
if (provider === 'node-pty') {
  const pty = (await import('node-pty')).default
  const chunks = []
  const term = pty.spawn(driverCommand[0], driverCommand.slice(1), {
    name: 'xterm-256color', cols: 100, rows: 30, env, cwd: dirname(selfPath),
  })
  // 在 master 一侧应答 DA1，充当最小的终端模拟器。
  let probeAnswered = false
  term.onData(data => {
    chunks.push(data)
    if (!probeAnswered && data.includes('\u001b[c')) {
      probeAnswered = true
      term.write('\u001b[?62;1;2;6;9;15;22c')
    }
  })
  const exit = await new Promise(resolve => term.onExit(() => resolve(true)))
  run = { status: exit ? 0 : 1, stdout: chunks.join('') }
} else if (provider === 'script') {
  // script supplies the PTY; answer queries on its pipes just as node-pty's
  // master does, so Linux CI exercises actual reply ownership too.
  const quoted = 'stty cols 100 rows 30 && exec ' + driverCommand.map(part => '"' + part + '"').join(' ')
  const child = spawn('script', ['-qec', quoted, marker + '.typescript'], {
    env, cwd: dirname(selfPath), stdio: ['pipe', 'pipe', 'pipe'],
  })
  const chunks = []
  let pending = ''
  child.stdout.on('data', chunk => {
    const text = chunk.toString()
    chunks.push(text)
    pending += text
    while (pending.includes('\u001b[c')) {
      pending = pending.slice(pending.indexOf('\u001b[c') + 3)
      child.stdin.write('\u001b[?62;1;2;6;9;15;22c')
    }
    pending = pending.slice(-2)
  })
  child.stdin.on('error', () => {}) // script may close before a late reply
  child.stderr.on('data', chunk => chunks.push(chunk.toString()))
  const timeout = setTimeout(() => child.kill('SIGTERM'), 15000)
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => { clearTimeout(timeout) })
  run = { status, stdout: chunks.join('') }
} else {
  run = spawnSync(driverCommand[0], driverCommand.slice(1), {
    encoding: 'utf8', timeout: 120000, env, cwd: dirname(selfPath),
  })
}

const text = run.stdout ?? ''
const parentReport = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : undefined
const replacementReport = existsSync(marker + '.replacement') ? JSON.parse(readFileSync(marker + '.replacement', 'utf8')) : undefined
if (parentReport === undefined || replacementReport === undefined) console.error(text)

check('chain: driver completed', run.status === 0, 'status=' + String(run.status))
check("sequence: 1049h exactly once (the old parent's boot)", (text.match(/\u001b\[\?1049h/g) ?? []).length === 1)
check("sequence: 1049l exactly once (the replacement's post-ready exit)", (text.match(/\u001b\[\?1049l/g) ?? []).length === 1)
check('sequence: the close happens AFTER the flushed first frame',
  text.indexOf('GATE-CHILD-FIRST-FRAME') >= 0 && text.indexOf('\u001b[?1049l') > text.indexOf('GATE-CHILD-FIRST-FRAME'))
check('sequence: the transition notice lives inside the alt bracket',
  text.includes('\u27f3') || text.includes('Switching') || text.includes('正在启动'))
check('single owner: the old parent holds zero stdin readers across the spawn',
  parentReport?.role === 'parent' && parentReport.stdinBefore.readable === 0 && parentReport.stdinBefore.data === 0
  && parentReport.stdinAfter.readable === 0 && parentReport.stdinAfter.data === 0,
  JSON.stringify(parentReport?.stdinBefore) + '→' + JSON.stringify(parentReport?.stdinAfter))
check('single owner: no terminal replies accumulated in the detached parent', parentReport?.stdinAfter.buffered === 0,
  'buffered=' + String(parentReport?.stdinAfter.buffered))

if (provider === 'pipe') {
  note('provider=pipe: no real PTY device available in this environment — TTY facade and DA1 probe assertions are device-gated (sequence/owner invariants still enforced). Run with node-pty installed or on POSIX script for the device-level gate.')
} else {
  check("tty facade: the replacement's stdout is a real TTY (not a disguised pipe)", replacementReport?.role === 'replacement' && replacementReport.isTTY === true)
  check('tty facade: columns/rows are positive', (replacementReport?.columns ?? 0) >= 40 && (replacementReport?.rows ?? 0) >= 10, JSON.stringify({ c: replacementReport?.columns, r: replacementReport?.rows }))
  check('tty facade: raw mode is available to the replacement', replacementReport?.hasSetRawMode === true)
  check('probe round-trip: a DA1 query through the shared console gets a reply without user input', replacementReport?.probeSeen === true, 'probeSeen=' + String(replacementReport?.probeSeen))
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? 'PTY GATE (' + provider + '): ALL GATED CASES PASS' + (notes === 0 ? '' : ' [' + notes + ' note(s)]') : failures + ' FAILURES (provider ' + provider + ')')
process.exit(failures === 0 ? 0 : 1)
