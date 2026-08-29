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
  env: Record<string, string>
  expected: ReturnType<typeof resolveTuiHostMode>
}[] = [
  {
    name: 'tty + no launcher marker → interactive',
    stdoutTty: true,
    env: {},
    expected: 'interactive',
  },
  {
    name: 'tty + launcher marker → interactive',
    stdoutTty: true,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'interactive',
  },
  {
    name: 'no tty + launcher marker → invalid-explicit-launch',
    stdoutTty: false,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'invalid-explicit-launch',
  },
  {
    name: 'no tty + no marker → headless-host',
    stdoutTty: false,
    env: {},
    expected: 'headless-host',
  },
]

for (const c of cases) {
  const actual = resolveTuiHostMode(c.stdoutTty, c.env)
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
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
