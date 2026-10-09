/**
 * Terminal capability gating regression (Web / Tauri coexistence, issue #1388).
 *
 * dsh-tui installed in a profile must not fail the whole DSH composition when
 * the host lacks terminal output or raw-mode input: the plugin skips itself
 * unless the process was explicitly launched through the dsh-tui launcher
 * (DSH_TUI_LAUNCHER_VERSION / standalone runtime), which keeps failing loudly.
 *
 * Run: node --import tsx/esm scripts/verify-tui-host-mode.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/dsh-adapter/index.js'

// Isolate preferences before importing the plugin, including on a bad baseline
// that wrongly proceeds past the terminal gate into agent setup.
const hostModeHome = mkdtempSync(join(tmpdir(), 'verify-tui-host-'))
process.env.HOME = hostModeHome
process.env.USERPROFILE = hostModeHome
process.env.DSH_HOME = join(hostModeHome, '.dsh')
mkdirSync(process.env.DSH_HOME, { recursive: true })
const { apply, resolveTuiHostMode } = await import('../src/dsh-adapter/plugin.js')

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
  stdinRawCapable: boolean
  env: Record<string, string>
  expected: 'interactive' | 'invalid-explicit-launch' | 'headless-host'
}[] = [
  {
    name: 'tty + no launcher marker → interactive',
    stdoutTty: true,
    stdinRawCapable: true,
    env: {},
    expected: 'interactive',
  },
  {
    name: 'tty + launcher marker → interactive',
    stdoutTty: true,
    stdinRawCapable: true,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'interactive',
  },
  {
    name: 'no tty + launcher marker → invalid-explicit-launch',
    stdoutTty: false,
    stdinRawCapable: false,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'invalid-explicit-launch',
  },
  {
    name: 'no tty + no marker → headless-host',
    stdoutTty: false,
    stdinRawCapable: false,
    env: {},
    expected: 'headless-host',
  },
  {
    name: 'stdout tty + no raw stdin + launcher marker → invalid-explicit-launch',
    stdoutTty: true,
    stdinRawCapable: false,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'invalid-explicit-launch',
  },
  {
    name: 'stdout tty + no raw stdin + no marker → headless-host',
    stdoutTty: true,
    stdinRawCapable: false,
    env: {},
    expected: 'headless-host',
  },
  {
    name: 'no stdout tty + raw stdin + launcher marker → invalid-explicit-launch',
    stdoutTty: false,
    stdinRawCapable: true,
    env: { DSH_TUI_LAUNCHER_VERSION: '9.9.9' },
    expected: 'invalid-explicit-launch',
  },
]

for (const c of cases) {
  const actual = resolveTuiHostMode(c.stdoutTty, c.env, c.stdinRawCapable)
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

const stdinDescriptors = new Map(['isTTY', 'setRawMode'].map(key => [key, Object.getOwnPropertyDescriptor(process.stdin, key)]))

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

  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  // Electron-as-node can keep stdout as a TTY while stdin has no raw-mode API.
  // Also cover a stream claiming isTTY without implementing setRawMode.
  for (const stdinTty of [undefined, true]) {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true })
    Object.defineProperty(process.stdin, 'setRawMode', { value: undefined, configurable: true })
    delete process.env.DSH_TUI_LAUNCHER_VERSION
    infoLogs.length = 0
    let skipped = false
    try {
      await apply(ctx, {} as unknown as Config)
      skipped = infoLogs.some(line => line.includes('skipping the TUI frontend'))
    } catch {
      // A late settings/render failure means the early host gate was bypassed.
    }
    check(`no raw stdin (isTTY=${stdinTty}): foreign host skips before setup`, skipped)

    process.env.DSH_TUI_LAUNCHER_VERSION = '9.9.9'
    message = ''
    try {
      await apply(ctx, {} as unknown as Config)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    check(
      `no raw stdin (isTTY=${stdinTty}): explicit launch explains the CLI workaround`,
      message.includes('stdin') && message.includes('raw mode') && message.includes('DSH_TUI_DSH_BIN'),
      message,
    )
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
  for (const [key, descriptor] of stdinDescriptors) {
    if (descriptor) Object.defineProperty(process.stdin, key, descriptor)
    else Reflect.deleteProperty(process.stdin, key)
  }
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
