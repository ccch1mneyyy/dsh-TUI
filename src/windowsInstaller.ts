import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cmdEscapeArgument, cmdEscapeCommand } from './utils/shellQuote.js'
import type { InstallerEvent, InstallerOptions } from './updateProcess.js'

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
}

/** Quote a single argv element for CreateProcess/CommandLineToArgvW. */
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

function commandLine(command: string, args: readonly string[], options: InstallerOptions): { application: string; commandLine: string } {
  if (!command || [command, ...args].some(value => value.includes('\0'))) throw new Error('Invalid installer command or argument')
  if (!options.shell) {
    // A null application lets CreateProcess search PATH for a bare executable.
    return { application: '', commandLine: [command, ...args].map(quoteWindowsArgument).join(' ') }
  }
  const env = options.env ?? process.env
  const application = environmentValue(env, 'ComSpec') || join(environmentValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe')
  const normalized = win32.normalize(command)
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(normalized)
  const line = [cmdEscapeCommand(normalized), ...args.map(arg => cmdEscapeArgument(arg, shim))].join(' ')
  return { application, commandLine: `${quoteWindowsArgument(application)} /d /s /c "${line}"` }
}

interface NativeResult {
  code: number
  cleanupConfirmed: boolean
  error?: string
}

function readResult(directory: string): NativeResult | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const result = value as Record<string, unknown>
    if (!Number.isInteger(result['code']) || typeof result['cleanupConfirmed'] !== 'boolean') return undefined
    return {
      code: result['code'] as number,
      cleanupConfirmed: result['cleanupConfirmed'],
      error: typeof result['error'] === 'string' ? result['error'] : undefined,
    }
  } catch { return undefined }
}

/** The supervisor owns a private job handle, including after the root exits. */
export function runWindowsInstaller(command: string, args: readonly string[], options: InstallerOptions, timeoutMs: number): Promise<number> {
  return new Promise(resolve => {
    let directory = ''
    let child: ReturnType<typeof spawn>
    try {
      const descriptor = commandLine(command, args, options)
      directory = mkdtempSync(join(tmpdir(), 'dsh-installer-'))
      writeFileSync(join(directory, 'config.json'), JSON.stringify({
        ...descriptor, parentPid: process.pid, parentNotAfterMs: Date.now(),
      }), { encoding: 'utf8', mode: 0o600 })
      // Source-mode tools and installed npm packages use different asset paths.
      const sourceAsset = new URL('../assets/windows-installer.ps1', import.meta.url)
      const script = fileURLToPath(existsSync(sourceAsset) ? sourceAsset : new URL('../../assets/windows-installer.ps1', import.meta.url))
      const env = options.env ?? process.env
      const powershell = join(environmentValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      // A restrictive outer Windows job can make spawn throw synchronously.
      // Establish no listeners or timers until a supervisor has been returned.
      child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, directory], {
        env: options.env,
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      options.onEvent?.({ category: options.category, stage: 'error', code: 127, message: String(error) })
      if (directory) {
        try { rmSync(directory, { recursive: true, force: true }) } catch (cleanupError) {
          options.onEvent?.({ category: options.category, stage: 'cleanup-error', code: 127, message: `Temporary installer control files could not be removed: ${String(cleanupError)}` })
        }
      }
      options.onEvent?.({ category: options.category, stage: 'close', code: 127 })
      resolve(127)
      return
    }
    let settled = false
    let stopCode: number | undefined
    let rootPid: number | undefined
    let lastOutputAt: number | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let startupDeadline: ReturnType<typeof setTimeout> | undefined
    let reapDeadline: ReturnType<typeof setTimeout> | undefined
    let statusPoll: ReturnType<typeof setInterval> | undefined
    let emergency = false
    const emit = (stage: InstallerEvent['stage'], code?: number, message?: string): void => {
      options.onEvent?.({ category: options.category, pid: rootPid, lastOutputAt, stage, code, message })
    }
    const finish = (code: number, removeDirectory = true): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(startupDeadline)
      clearTimeout(reapDeadline)
      clearInterval(statusPoll)
      options.signal?.removeEventListener('abort', onAbort)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      process.removeListener('SIGHUP', onHangup)
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      if (removeDirectory) {
        try { rmSync(directory, { recursive: true, force: true }) } catch (error) {
          emit('cleanup-error', code, `Temporary installer control files could not be removed: ${String(error)}`)
        }
      }
      emit('close', code)
      resolve(code)
    }
    const forceSupervisorExit = (): void => {
      if (settled || emergency) return
      emergency = true
      emit('cleanup-error', stopCode ?? 127, 'Windows installer supervisor did not confirm an empty job; closing its owned handle is a fail-safe, but cleanup is unconfirmed')
      // ChildProcess retains the supervisor's process handle. This is never a
      // taskkill of an exited installer PID, nor discovery by process name.
      child.kill()
      reapDeadline = setTimeout(() => {
        // Keep config/cancel if supervisor exit cannot be observed: a late
        // startup must still see cancellation and must never run the payload.
        finish(stopCode ?? 127, false)
      }, 2000)
    }
    const stop = (code: number, stage: 'cancel' | 'timeout' | 'error', message?: string): void => {
      if (settled || stopCode !== undefined) return
      stopCode = code
      clearTimeout(deadline)
      clearTimeout(startupDeadline)
      emit(stage, code, message)
      try { writeFileSync(join(directory, 'cancel'), '') } catch (error) {
        emit('cleanup-error', code, `Cannot request Windows job termination: ${String(error)}`)
        forceSupervisorExit()
        return
      }
      reapDeadline = setTimeout(forceSupervisorExit, 8000)
    }
    const onAbort = (): void => stop(130, 'cancel')
    const onInterrupt = (): void => stop(130, 'cancel')
    const onTerminate = (): void => stop(143, 'cancel')
    const onHangup = (): void => stop(129, 'cancel')
    const pollReady = (): void => {
      if (rootPid !== undefined || settled) return
      try {
        const ready: unknown = JSON.parse(readFileSync(join(directory, 'ready'), 'utf8'))
        if (typeof ready !== 'object' || ready === null) return
        const status = ready as Record<string, unknown>
        if (!Number.isSafeInteger(status['pid']) || (status['pid'] as number) <= 0 || status['member'] !== true || status['inheritable'] !== false) return
        rootPid = status['pid'] as number
        clearTimeout(startupDeadline)
        emit('start', undefined, 'Private Windows job membership verified; job handle inheritance disabled')
      } catch { /* Atomic ready file has not been published yet. */ }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      lastOutputAt = Date.now()
      options.onStdout?.(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      lastOutputAt = Date.now()
      options.onStderr?.(chunk)
    })
    child.once('error', error => {
      emit('error', 127, error.message)
      if (child.pid === undefined) finish(stopCode ?? 127)
      else stop(127, 'error', error.message)
    })
    child.once('exit', () => {
      if (settled) {
        // An emergency bound may settle before process exit is confirmed.
        try { rmSync(directory, { recursive: true, force: true }) } catch { /* Already reported unconfirmed cleanup. */ }
        return
      }
      clearTimeout(deadline)
      clearTimeout(startupDeadline)
      clearTimeout(reapDeadline)
      if (!readResult(directory) && stopCode === undefined) {
        stopCode = 127
        emit('error', 127, 'Windows installer supervisor exited without a result')
      }
      reapDeadline = setTimeout(() => {
        emit('cleanup-error', stopCode ?? 127, 'Windows supervisor exited but installer streams did not close; cleanup is unconfirmed')
        finish(stopCode ?? 127)
      }, 2000)
    })
    child.once('close', () => {
      if (settled) return
      pollReady()
      const result = readResult(directory)
      if (!result || !result.cleanupConfirmed) {
        if (!emergency) emit('cleanup-error', stopCode ?? 127, result?.error || 'Windows supervisor exited without confirming installer job cleanup')
        finish(stopCode ?? 127)
      } else {
        if (result.error) emit('error', result.code, result.error)
        finish(stopCode ?? (emergency ? 127 : result.code))
      }
    })
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    process.on('SIGHUP', onHangup)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    statusPoll = setInterval(pollReady, 50)
    deadline = setTimeout(() => stop(124, 'timeout'), timeoutMs)
    startupDeadline = setTimeout(() => stop(127, 'error', 'Windows installer supervisor did not establish job ownership within 30 seconds'), 30000)
    if (options.signal?.aborted) onAbort()
  })
}
