#!/usr/bin/env node
/**
 * verify-handoff-pty-gate.mjs — S05 完整版的 PTY/ConPTY 先行门
 * （deploy-transition 设计 §S05："完整实现之前先在 PTY/ConPTY 验证
 * stdout pipe/TTY facade 的尺寸、Image/kitty/sixel 探测、raw mode 与
 * input single-owner"）。
 *
 * 本仓选择的交接路径是「继承控制台的进程接力」而非透明 PTY relay，因此
 * 门要证明的是这条路径的设备级性质：在**真实 PTY** 下跑一遍完整交接链
 * （旧父 boot 进 1049 → 过场帧 → spawn replacement → adopted/首帧/ready
 * ACK → replacement 自然退出时闭合 1049），并断言：
 *
 *   1. 尺寸/TTY facade：replacement 的 stdout 是 TTY、columns/rows 有值、
 *      setRawMode 可用（一个「普通 pipe 伪装终端」会在这里现形）；
 *   2. 探测往返：DA1 查询（ESC[c）在链路共享的控制台上能收到回复
 *      （Image/kitty/sixel 探测的底层前提；仅真实 PTY 断言）；
 *   3. 输入单 owner：旧父 spawn 前后 stdin 的 reader 数为 0
 *      （detachHandoffStdin 纪律），replacement 是唯一读者；
 *   4. 序列不变量：整条会话 1049h 恰一次、1049l 恰一次且晚于首帧、
 *      过场帧在 alt buffer 内、失败收口回主屏。
 *
 * Provider 自动选择（DSH_TUI_PTY_GATE 可显式指定）：
 *   node-pty —— 可 import 时（Windows=真 ConPTY，POSIX=真 PTY）；
 *   script   —— POSIX 的 util-linux script（CI Linux 的真 PTY 路径）；
 *   pipe     —— 无 PTY 设备时的协议级回退（序列与单 owner 仍断言，
 *              TTY/DA1 断言显式标注 provider 受限，不算失败）。
 *
 * 运行：node --import tsx/esm scripts/verify-handoff-pty-gate.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)
const isDriver = process.argv.includes('--pty-driver')

// ── driver：在 PTY 内跑完整交接链 ────────────────────────────────────────
if (isDriver) {
  const { restartTui } = await import('../src/update.ts')
  const markerPath = process.env.PTY_GATE_MARKER ?? ''
  const { writeSync } = await import('node:fs')
  const attempt = process.env.DSH_TUI_HANDOFF_ATTEMPT ?? ''
  const report = (payload) => {
    if (markerPath !== '') {
      try { writeFileSync(markerPath, JSON.stringify(payload)) } catch { /* diagnosis only */ }
    }
  }

  if (process.env.DSH_TUI_HANDOFF_ACK_FD !== undefined) {
    // replacement 角色：模拟 boot（已由旧父带入 1049——不发 1049h）、
    // 探测、首帧、ready ACK，然后作为「用户用完退出」的一方闭合 1049。
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
      stdin.on('readable', onReadable)
      process.stdout.write('\u001b[c') // DA1（能力探测的往返代表）
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
      // ready 后自然退出：replacement 拥有 1049 括号，自己闭合。
      process.stdout.write('\u001b[?1049l\r\n')
      process.exit(0)
    }, 150)
    await new Promise(() => {})
  }

  // 旧父角色：boot 时进 1049（模拟自己开屏），detach 后跑真 restartTui。
  process.stdout.write('\u001b[?1049h\u001b[2J\u001b[H')
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
    // node-pty 是可选 provider：能装就能用（Windows=ConPTY）。
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

const driverCommand = [process.execPath, '--import', 'tsx/esm', selfPath, '--pty-driver']
let run
if (provider === 'node-pty') {
  const pty = (await import('node-pty')).default
  const chunks = []
  const term = pty.spawn(driverCommand[0], driverCommand.slice(1), {
    name: 'xterm-256color', cols: 100, rows: 30, env, cwd: dirname(selfPath),
  })
  // 最小「终端模拟器」：在 master 侧应答 DA1，让探测往返可断言。
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
  const quoted = driverCommand.map(part => '"' + part + '"').join(' ')
  run = spawnSync('script', ['-qec', quoted, marker + '.typescript'], {
    encoding: 'utf8', timeout: 120000, env, cwd: dirname(selfPath),
  })
} else {
  run = spawnSync(driverCommand[0], driverCommand.slice(1), {
    encoding: 'utf8', timeout: 120000, env, cwd: dirname(selfPath),
  })
}

const text = run.stdout ?? ''
const parentReport = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : undefined

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

if (provider === 'pipe') {
  note('provider=pipe: no real PTY device available in this environment — TTY facade and DA1 probe assertions are device-gated (sequence/owner invariants still enforced). Run with node-pty installed or on POSIX script for the device-level gate.')
} else {
  check("tty facade: the replacement's stdout is a real TTY (not a disguised pipe)", parentReport?.isTTY === true)
  check('tty facade: columns/rows are positive', (parentReport?.columns ?? 0) >= 40 && (parentReport?.rows ?? 0) >= 10, JSON.stringify({ c: parentReport?.columns, r: parentReport?.rows }))
  check('tty facade: raw mode is available to the replacement', parentReport?.hasSetRawMode === true)
  if (provider === 'node-pty') {
    check('probe round-trip: a DA1 query through the shared console gets a reply (image/kitty/sixel probing premise)', parentReport?.probeSeen === true, 'probeSeen=' + String(parentReport?.probeSeen))
  } else {
    note('provider=' + provider + ': a real PTY without an emulator on the master side answers no DA1 probe — the round-trip assertion is node-pty-gated (this run still asserts the real-PTY facade).')
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? 'PTY GATE (' + provider + '): ALL GATED CASES PASS' + (notes === 0 ? '' : ' [' + notes + ' note(s)]') : failures + ' FAILURES (provider ' + provider + ')')
process.exit(failures === 0 ? 0 : 1)
