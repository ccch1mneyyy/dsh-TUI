import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gt, valid } from 'semver'

const PACKAGE_NAME = 'dsh-cc-tui'
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const UPDATE_CHECK_TIMEOUT_MS = 4000

export interface TuiUpdateInfo {
  current: string
  latest: string
}

/** Read the version from either the compiled package or the source checkout. */
function installedVersion(): string | undefined {
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
  const current = installedVersion()
  if (current === undefined) return undefined
  const currentVersion = valid(current)
  if (currentVersion === null) return undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(REGISTRY_URL, {
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
    const child = spawn(command, args, {
      env: options.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
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
 * @param sessionId - Session to resume in the replacement process.
 * @returns The replacement process exit code.
 */
export async function updateTuiAndRestart(sessionId: string): Promise<number> {
  const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const updateCode = await runProcess(dsh, [
    'plugin',
    '--profile',
    'cc-tui',
    'update',
    'dsh-cc-tui',
  ])
  if (updateCode !== 0) return updateCode

  return runProcess(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    env: {
      ...process.env,
      DSH_CC_RESUME_SESSION: sessionId,
    },
  })
}
