/**
 * Child-stderr guard regression (issue #17): an MCP server spawned with an
 * inherited stderr (the MCP SDK's stdio default) writes straight to the
 * terminal device from the child process, bypassing the renderer's
 * process.stderr patch and corrupting the alt-screen. The guard rewrites such
 * spawns to a pipe and surfaces the lines as deduplicated notifications.
 *
 * Fixture modes (re-run this file as `--import tsx/esm <self> <mode>`):
 * the fixture spawns a grandchild that writes BOOM-LINE to stderr with an
 * inherited fd 2, with or without the guard installed. The driver captures
 * the fixture's stderr and asserts the raw line reaches fd 2 only when
 * unguarded. The fixture calls `spawn` through the default-import exports
 * object — the same access pattern cross-spawn (used by the MCP SDK) has.
 *
 * Driver mode additionally unit-tests the reporter: debounce dedup with a
 * repeat count, cooldown silence, ANSI stripping, truncation, empty lines,
 * and late stderr after reporter disposal (#1979).
 */
process.env.DSH_TUI_LANG = 'zh'

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { settled, sleep } from './lib/term-test.mjs'

const SELF = fileURLToPath(import.meta.url)

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

async function runInner(mode: string): Promise<void> {
  if (mode === 'inner-disposed-tail' || mode === 'inner-active-tail') {
    await runLateTail(mode === 'inner-disposed-tail')
    return
  }
  const { installChildStderrGuard } = await import('../src/dsh-adapter/childStderr.js')
  if (mode !== 'inner-plain') {
    installChildStderrGuard(line => process.stdout.write(`SINK:${line}\n`))
  }
  // Default import = the CJS exports object, read at call time — this is the
  // access pattern the patch must cover (cross-spawn does exactly this).
  const childProcess = (await import('node:child_process')).default
  const stdio = mode === 'inner-guard-string' ? 'inherit' : ['pipe', 'pipe', 'inherit']
  const child = childProcess.spawn(process.execPath, ['-e', 'process.stderr.write("BOOM-LINE\\n")'], {
    stdio,
  } as never)
  process.stdout.write(child.stderr === null ? 'STDERR-NULL\n' : 'STDERR-PIPED\n')
  child.on('exit', () => setTimeout(() => process.exit(0), 100))
}

async function runLateTail(disposeReporter: boolean): Promise<void> {
  const { createChildStderrReporter, installChildStderrGuard } = await import('../src/dsh-adapter/childStderr.js')
  const { createChannelUiLease, CHANNEL_UI_LIFETIME_ENDED } = await import('../src/adapter/channel/ui.js')
  const { installNestedUpdateOverflowProcessGuard } = await import('../src/ink/update-overflow-guard.js')
  installNestedUpdateOverflowProcessGuard()
  const lease = createChannelUiLease(() => true)
  let notices = 0
  const reporter = createChildStderrReporter(() => { lease.assertActive(); notices++ }, { debounceMs: 50 })
  const lines: string[] = []
  const restore = installChildStderrGuard(line => {
    lines.push(line)
    process.stdout.write(`TAIL:${line}\n`)
    reporter.push(line)
  })
  try {
    const childProcess = (await import('node:child_process')).default
    const child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => process.stderr.write("late-tail"), 25)'], {
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    })
    const closed = once(child, 'close')
    assert.notEqual(child.stderr, null)
    if (disposeReporter) reporter.dispose()
    lease.dispose()
    assert.throws(() => lease.assertActive(), { message: CHANNEL_UI_LIFETIME_ENDED })
    const [code, signal] = await closed
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.deepEqual(lines, ['late-tail'])
    // 固定窗:探针 销毁后不得产生通知，必须越过 debounce 窗口观察。
    await sleep(150)
    assert.equal(notices, 0)
    assert.equal(disposeReporter, true, 'active reporter must still expose the ended-lease error')
    console.log('DISPOSED-TAIL-SURVIVED')
  } finally {
    reporter.dispose()
    lease.dispose()
    restore()
  }
}

function runFixture(mode: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', SELF, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => resolve({ stdout, stderr, code }))
  })
}

async function runDriver(): Promise<void> {
  // ── fixture: unguarded inherited stderr reaches fd 2 ──────────────────
  const plain = await runFixture('inner-plain')
  check('未接管：inherit 的子进程 stderr 直达 fd 2（复现 issue 场景）', plain.stderr.includes('BOOM-LINE'))
  check('未接管：inherit 的子进程 stderr 不可读（STDERR-NULL）', plain.stdout.includes('STDERR-NULL'))

  // ── fixture: guarded, stdio array form ────────────────────────────────
  const guarded = await runFixture('inner-guard')
  check('接管（数组 stdio）：裸 stderr 不再到达 fd 2', !guarded.stderr.includes('BOOM-LINE'))
  check('接管（数组 stdio）：stderr 被改成管道（STDERR-PIPED）', guarded.stdout.includes('STDERR-PIPED'))
  check('接管（数组 stdio）：输出行进入受控 sink', guarded.stdout.includes('SINK:BOOM-LINE'))

  // ── fixture: guarded, whole-stdio 'inherit' string form ───────────────
  const guardedString = await runFixture('inner-guard-string')
  check('接管（字符串 stdio）：裸 stderr 不再到达 fd 2', !guardedString.stderr.includes('BOOM-LINE'))
  check('接管（字符串 stdio）：输出行进入受控 sink', guardedString.stdout.includes('SINK:BOOM-LINE'))

  const disposedTail = await runFixture('inner-disposed-tail')
  check('销毁后：真实子进程的无换行 stderr 尾部仍进入 sink', disposedTail.stdout.includes('TAIL:late-tail') && !disposedTail.stderr.includes('late-tail'))
  check('销毁后：尾部不再调度失效 Channel 通知，进程自然退出 0', disposedTail.code === 0 && disposedTail.stdout.includes('DISPOSED-TAIL-SURVIVED'))
  const activeTail = await runFixture('inner-active-tail')
  check('负对照：未销毁 reporter 仍暴露失效 Channel 错误，不吞异常', activeTail.code === 7 && activeTail.stderr.includes('dsh-tui: Channel UI lifetime has ended') && activeTail.stdout.includes('TAIL:late-tail'))

  // ── reporter: dedup / cooldown / cleanup ──────────────────────────────
  const { createChildStderrReporter } = await import('../src/dsh-adapter/childStderr.js')
  const notices: string[] = []
  const reporter = createChildStderrReporter(text => notices.push(text), {
    debounceMs: 60,
    cooldownMs: 400,
    maxLineLength: 50,
  })
  const failing = 'Error: Non-HTTPS URLs are only allowed for localhost'

  reporter.push(failing)
  reporter.push(failing)
  reporter.push(failing)
  // 固定窗:探针 不得多出通知：settle 会在第一条通知出现时立即返回，
  // 测不到「只出一条」的上界。
  await sleep(150)
  check('去重：同一行连发 3 次只出一条通知', notices.length === 1)
  check('去重：通知带重复计数（重复 3 次）', notices[0]?.includes('重复 3 次') ?? false)

  reporter.push(failing)
  // 固定窗:探针 冷却期内不得出新通知：条件在 push 前就成立，轮询等于没测。
  await sleep(150)
  check('冷却：刚通知过的行在冷却期内静默', notices.length === 1)

  // 固定窗:墙钟 等 reporter 的 cooldownMs=400 冷却窗过去，没有可观察的状态翻转。
  await sleep(400)
  reporter.push(failing)
  check('冷却结束：同一行可再次通知', await settled(() => notices.length === 2))

  reporter.push('Usage: tsx proxy.ts <url>')
  check('不同的行各自成条通知', await settled(() => notices.length === 3 && (notices[2]?.includes('Usage:') ?? false)))

  reporter.push('\x1b[31mred-line\x1b[39m')
  check('ANSI 转义被剥离', await settled(() => (notices.at(-1) ?? '').includes('red-line') && !(notices.at(-1) ?? '').includes('\x1b')))

  const longLine = 'x'.repeat(100)
  reporter.push(longLine)
  check('超长行被截断（带省略号）', await settled(() => (notices.at(-1) ?? '').includes('…') && !(notices.at(-1) ?? '').includes(longLine)))

  const countBefore = notices.length
  reporter.push('   ')
  reporter.push('')
  // 固定窗:探针 空行不得产生通知：条件在 push 前就成立，轮询等于没测。
  await sleep(150)
  check('空行/纯空白行被丢弃', notices.length === countBefore)

  const beforeDispose = notices.length
  reporter.push('pending-before-dispose')
  reporter.dispose()
  reporter.dispose()
  reporter.push('late-after-dispose')
  // 固定窗:探针 已排队通知必须取消，重复销毁与迟到 push 也不得重新调度。
  await sleep(150)
  check('销毁是终态：取消在途通知、重复销毁安全、迟到 push 静默', notices.length === beforeDispose)

  console.log(results.join('\n'))
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall child-stderr guard checks passed')
}

const mode = process.argv[2]
if (mode !== undefined && mode.startsWith('inner-')) {
  await runInner(mode)
} else {
  await runDriver()
}
