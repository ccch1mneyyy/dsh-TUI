/**
 * Non-TTY host gating regression (Web / Tauri coexistence).
 *
 * dsh-tui installed in a profile must not fail the whole DSH composition when
 * the host is not a terminal (stdout piped or null): the plugin skips itself
 * unless the process was explicitly launched through the dsh-tui launcher
 * (DSH_TUI_LAUNCHER_VERSION / standalone runtime), which keeps failing loudly.
 *
 * Run: node --import tsx/esm scripts/verify-tui-host-mode.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { apply, resolveTuiHostMode } from '../src/dsh-adapter/plugin.js'
import type { Config } from '../src/dsh-adapter/index.js'

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

// ── unit: resolveTuiHostMode over the explicit-launch matrix ──────────────

const cases: {
  name: string
  stdoutTty: boolean
  stdinTty: boolean
  env: Record<string, string>
  expected: ReturnType<typeof resolveTuiHostMode>
}[] = [
  {
    name: 'tty + no launcher marker → interactive',
    stdoutTty: true,
    stdinTty: true,
    env: {},
    expected: 'interactive',
  },
  {
    name: 'tty + launcher marker → interactive',
    stdoutTty: true,
    stdinTty: true,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'interactive',
  },
  {
    name: 'no tty + launcher marker → invalid-explicit-launch',
    stdoutTty: false,
    stdinTty: false,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'invalid-explicit-launch',
  },
  {
    name: 'no tty + no marker → headless-host',
    stdoutTty: false,
    stdinTty: false,
    env: {},
    expected: 'headless-host',
  },
  {
    name: 'tty stdout + piped stdin + no marker → invalid-explicit-launch',
    stdoutTty: true,
    stdinTty: false,
    env: {},
    expected: 'invalid-explicit-launch',
  },
  {
    name: 'tty stdout + piped stdin + launcher marker → invalid-explicit-launch',
    stdoutTty: true,
    stdinTty: false,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'invalid-explicit-launch',
  },
  {
    name: 'piped stdout + tty stdin + no marker → headless-host',
    stdoutTty: false,
    stdinTty: true,
    env: {},
    expected: 'headless-host',
  },
  {
    name: 'piped stdout + tty stdin + launcher marker → invalid-explicit-launch',
    stdoutTty: false,
    stdinTty: true,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'invalid-explicit-launch',
  },
]

for (const c of cases) {
  const actual = resolveTuiHostMode(c.stdoutTty, c.env, c.stdinTty)
  check(`${c.name} (got ${actual})`, actual === c.expected)
}

// Standalone runtime counts as an explicit launch (isStandaloneRuntime reads
// the real process env, so drive it through the environment).
const prevStandalone = process.env.DSH_TUI_STANDALONE
process.env.DSH_TUI_STANDALONE = '1'
check(
  'no tty + DSH_TUI_STANDALONE=1 → invalid-explicit-launch',
  resolveTuiHostMode(false) === 'invalid-explicit-launch',
)
if (prevStandalone === undefined) {
  delete process.env.DSH_TUI_STANDALONE
} else {
  process.env.DSH_TUI_STANDALONE = prevStandalone
}

// ── integration: apply() under a non-TTY stdout ────────────────────────────
// The gate reads `process.stdout.isTTY` directly; override it for the process
// and restore afterwards (no own descriptor on real TTYs, so delete restores).

const stdoutIsTTYOwn = Object.prototype.hasOwnProperty.call(process.stdout, 'isTTY')
const stdoutIsTTYDescriptor = stdoutIsTTYOwn
  ? Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  : undefined
const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })

const prevLauncherVersion = process.env.DSH_TUI_LAUNCHER_VERSION
delete process.env.DSH_TUI_LAUNCHER_VERSION

const infoLogs: string[] = []
const ctx = new Context()
const logger = ctx.logger
const origInfo = logger.info.bind(logger)
logger.info = ((message: unknown) => {
  infoLogs.push(String(message))
}) as typeof logger.info

try {
  // headless host: apply resolves, no throw, no render path reached
  await apply(ctx, {} as unknown as Config)
  check('headless-host: apply resolves without throwing', true)
  check(
    'headless-host: skip reason logged at info level',
    infoLogs.some((line) => line.includes('skipping the TUI frontend')),
    infoLogs.join(' | '),
  )

  // explicit launch without a TTY: the previous loud error is preserved
  process.env.DSH_TUI_LAUNCHER_VERSION = '9.9.9'
  let rejected = false
  let message = ''
  try {
    await apply(ctx, {} as unknown as Config)
  } catch (error) {
    rejected = true
    message = error instanceof Error ? error.message : String(error)
  }
  check('invalid-explicit-launch: apply rejects', rejected)
  check(
    'invalid-explicit-launch: original error message preserved',
    message.includes('interactive terminal'),
    message,
  )

  // #1761: a Windows GUI executable can inherit TTY output while its stdin
  // is a pipe. Keep the old no-output/headless cases above, and reject this
  // incomplete terminal before any channel/UI mounting (marked or direct).
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  for (const marker of [undefined, '9.9.9']) {
    if (marker === undefined) delete process.env.DSH_TUI_LAUNCHER_VERSION
    else process.env.DSH_TUI_LAUNCHER_VERSION = marker
    const mode = resolveTuiHostMode()
    check(`piped stdin with marker=${String(marker)}: gate rejects before mounting`, mode === 'invalid-explicit-launch', mode)
    // A bad baseline has already failed the check: do not mount its known
    // invalid input into Ink merely to reproduce an unsafe secondary crash.
    if (mode !== 'invalid-explicit-launch') continue
    let failure = ''
    try { await apply(ctx, {} as unknown as Config) } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    check(`piped stdin with marker=${String(marker)}: actionable early error`,
      failure.includes('stdin and stdout') && failure.includes('node') && failure.includes('host-entry.js'), failure)
    check(`piped stdin with marker=${String(marker)}: no Ink/lifetime cascade`,
      !failure.includes('Raw mode') && !failure.includes('lifetime has ended'), failure)
  }
} finally {
  logger.info = origInfo
  if (prevLauncherVersion === undefined) {
    delete process.env.DSH_TUI_LAUNCHER_VERSION
  } else {
    process.env.DSH_TUI_LAUNCHER_VERSION = prevLauncherVersion
  }
  if (stdoutIsTTYOwn) {
    Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTYDescriptor as PropertyDescriptor)
  } else {
    Reflect.deleteProperty(process.stdout, 'isTTY')
  }
  if (stdinIsTTYDescriptor !== undefined) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor)
  else Reflect.deleteProperty(process.stdin, 'isTTY')
  await ctx.root.fiber.dispose()
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
