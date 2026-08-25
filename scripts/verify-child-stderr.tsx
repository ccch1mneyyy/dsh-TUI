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
 * repeat count, cooldown silence, ANSI stripping, truncation, empty lines.
 */
process.env.DSH_TUI_LANG = 'zh'

import { spawn } from 'node:child_process'
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
    child.on('exit', code => resolve({ stdout, stderr, code }))
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
  // 稳定性探针（不得多出通知）：settle 会在第一条通知出现时立即返回，
  // 测不到「只出一条」的上界——保留固定窗口。
  await sleep(150)
  check('去重：同一行连发 3 次只出一条通知', notices.length === 1)
  check('去重：通知带重复计数（重复 3 次）', notices[0]?.includes('重复 3 次') ?? false)

  reporter.push(failing)
  // 稳定性探针（冷却期内不得出新通知）：条件在 push 前就成立，轮询等于
  // 没测——保留固定窗口。
  await sleep(150)
  check('冷却：刚通知过的行在冷却期内静默', notices.length === 1)

  // 纯排序等待：冷却窗口是墙钟时间，没有可观察的状态翻转——保留。
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
  // 稳定性探针（空行不得产生通知）：条件在 push 前就成立——保留固定窗口。
  await sleep(150)
  check('空行/纯空白行被丢弃', notices.length === countBefore)

  reporter.dispose()

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
