import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gt, valid } from 'semver'

const PACKAGE_NAME = 'dsh-cc-tui'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_CHECK_TIMEOUT_MS = 4000
/** env marker set on the /update restart; the new process verifies it at boot. */
const UPDATED_FROM_ENV = 'DSH_CC_UPDATED_FROM'

export interface TuiUpdateInfo {
  current: string
  latest: string
}

export interface TuiUpdateResult {
  /** Exit code of the `dsh plugin update` run (0 = the package was updated). */
  updateCode: number
  /**
   * Exit code of the restarted TUI process. Equals `updateCode` when the
   * failure happened before a restart was attempted.
   */
  restartCode: number
}

/** Read the version from either the compiled package or the source checkout. */
export function installedTuiVersion(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const relativePath of ['../../package.json', '../package.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(here, relativePath), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const packageJson = parsed as Record<string, unknown>
        const version = packageJson.version
        if (packageJson.name === PACKAGE_NAME && typeof version === 'string' && valid(version) !== null) {
          return version
        }
      }
    } catch {
      // Try the source-layout fallback after the compiled-layout path.
    }
  }
  return undefined
}

/**
 * Resolve the registry base URL the way npm/pnpm would: `NPM_CONFIG_REGISTRY`
 * (both spellings) over the `registry=` line in ~/.npmrc over npmjs.org, so
 * mirror users see the same `latest` their package manager would install.
 */
export function resolveRegistryBase(): string {
  const fromEnv = process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.replace(/\/+$/, '')
  try {
    const npmrc = readFileSync(join(homedir(), '.npmrc'), 'utf8')
    const match = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(npmrc)
    if (match !== null) return match[1].replace(/\/+$/, '')
  } catch {
    // No readable user .npmrc — the default registry applies.
  }
  return DEFAULT_REGISTRY
}

/** True when `current` is a strictly newer valid version than `previous`. */
export function isVersionNewer(current: string, previous: string): boolean {
  const a = valid(current)
  const b = valid(previous)
  return a !== null && b !== null && gt(a, b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Check npm for a newer published TUI version.
 *
 * Network and registry errors are intentionally treated as "no result" so an
 * offline launch never delays or blocks the interactive TUI.
 */
export async function checkForTuiUpdate(): Promise<TuiUpdateInfo | undefined> {
  const current = installedTuiVersion()
  if (current === undefined) return undefined
  const currentVersion = valid(current)
  if (currentVersion === null) return undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(`${resolveRegistryBase()}/${PACKAGE_NAME}/latest`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    const latest = isRecord(payload) && typeof payload.version === 'string'
      ? valid(payload.version)
      : null
    if (latest === null || !gt(latest, currentVersion)) return undefined
    return { current: currentVersion, latest }
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/** cmd.exe joins spawn arguments with spaces; quote anything that could split. */
function shellQuote(args: readonly string[]): string[] {
  return args.map(arg => (/[ \t"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg))
}

interface ProcessOptions {
  env?: NodeJS.ProcessEnv
}

/** Run a child process with its output attached to the user's terminal. */
function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<number> {
  return new Promise(resolve => {
    let settled = false
    const useShell = process.platform === 'win32'
    const child = spawn(command, useShell ? shellQuote(args) : args, {
      env: options.env,
      stdio: 'inherit',
      shell: useShell,
    })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }
    child.once('error', error => {
      process.stderr.write(`cc-tui: failed to run ${command}: ${error.message}\n`)
      finish(127)
    })
    child.once('close', code => finish(code ?? 1))
  })
}

/**
 * Update the installed cc-tui package and restart the same launcher while
 * preserving the active session. The TUI must already be unmounted before
 * this is called so pnpm output cannot corrupt the rendered terminal frame.
 *
 * `--latest` is required: `pnpm add` writes a caret range into the profile
 * manifest, and a plain `pnpm update` stays inside that range — with this
 * project's minor-per-release cadence the TUI would restart unchanged while
 * reporting success. The restart carries `DSH_CC_UPDATED_FROM` so the new
 * process can warn when the version did not actually move (e.g. a mirror
 * registry still serving the old `latest`).
 *
 * @param sessionId - Session to resume in the replacement process.
 * @returns Exit codes for the update run and the replacement process.
 */
export async function updateTuiAndRestart(sessionId: string): Promise<TuiUpdateResult> {
  const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const updateCode = await runProcess(dsh, [
    'plugin',
    '--profile',
    'cc-tui',
    'update',
    '--latest',
    'dsh-cc-tui',
  ])
  if (updateCode !== 0) return { updateCode, restartCode: updateCode }

  const restartCode = await runProcess(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    env: {
      ...process.env,
      DSH_CC_RESUME_SESSION: sessionId,
      [UPDATED_FROM_ENV]: installedTuiVersion() ?? '',
    },
  })
  return { updateCode, restartCode }
}
