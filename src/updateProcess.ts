import { spawn } from 'node:child_process'
import { runWindowsInstaller } from './windowsInstaller.js'

/** Conservative wall-clock limit, independent of output/silence. */
export const DEFAULT_UPDATE_TIMEOUT_MS = 30 * 60 * 1000

export function updateTimeoutMs(value = process.env['DSH_TUI_UPDATE_TIMEOUT_MS']): number {
  const parsed = value === undefined ? NaN : Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2 ** 31 - 1
    ? parsed
    : DEFAULT_UPDATE_TIMEOUT_MS
}

export interface InstallerEvent {
  readonly category: string
  readonly pid?: number
  readonly lastOutputAt?: number
  readonly stage: 'start' | 'timeout' | 'cancel' | 'error' | 'close' | 'cleanup-error'
  readonly code?: number
  readonly message?: string
}

export interface InstallerOptions {
  env?: NodeJS.ProcessEnv
  shell?: boolean
  category: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Grace period for this owned process group, before forceful termination. */
  terminationGraceMs?: number
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
  onEvent?: (event: InstallerEvent) => void
}

/** Installer-only runner: one result, owned tree cancellation, bounded cleanup.
 * Output is observational; even "Done" cannot settle the process successfully.
 */
export function runInstallerProcess(command: string, args: readonly string[], options: InstallerOptions): Promise<number> {
  if (options.signal?.aborted) {
    options.onEvent?.({ category: options.category, stage: 'cancel', code: 130 })
    return Promise.resolve(130)
  }
  if (process.platform === 'win32') {
    return runWindowsInstaller(command, args, options, options.timeoutMs ?? updateTimeoutMs(options.env?.['DSH_TUI_UPDATE_TIMEOUT_MS']))
  }
  return new Promise(resolve => {
    let settled = false
    let stopping = false
    let childClosed = false
    let treeTerminated = false
    let stopCode = 1
    let lastOutputAt: number | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    let reapDeadline: ReturnType<typeof setTimeout> | undefined
    const timeoutMs = options.timeoutMs ?? updateTimeoutMs(options.env?.['DSH_TUI_UPDATE_TIMEOUT_MS'])
    const graceMs = options.terminationGraceMs ?? 2000
    // A separate POSIX process group is the ownership boundary. Never signal
    // the app's own group, and never enumerate/kill processes by executable name.
    const child = spawn(command, [...args], {
      env: options.env,
      detached: true,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    const emit = (stage: InstallerEvent['stage'], code?: number, message?: string): void => {
      options.onEvent?.({ category: options.category, pid: child.pid, lastOutputAt, stage, code, message })
    }
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(escalation)
      clearTimeout(reapDeadline)
      options.signal?.removeEventListener('abort', onAbort)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      process.removeListener('SIGHUP', onHangup)
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      emit('close', code)
      resolve(code)
    }
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          emit('cleanup-error', stopCode, error instanceof Error ? error.message : String(error))
        }
      }
    }
    const afterKill = (): void => {
      treeTerminated = true
      if (childClosed) finish(stopCode)
      else reapDeadline = setTimeout(() => {
        emit('cleanup-error', stopCode, 'Installer did not close after tree termination; inspect the recorded PID before repairing the installation')
        finish(stopCode)
      }, 2000)
    }
    const stop = (code: number, stage: 'timeout' | 'cancel'): void => {
      if (settled || stopping) return
      stopping = true
      stopCode = code
      clearTimeout(deadline)
      emit(stage, code)
      if (child.pid === undefined) { finish(code); return }
      signalGroup('SIGTERM')
      // Always escalate the owned GROUP even if its root exits on TERM:
      // a grandchild may ignore TERM or hold the inherited pipes open.
      escalation = setTimeout(() => { signalGroup('SIGKILL'); afterKill() }, graceMs)
    }
    const onAbort = (): void => stop(130, 'cancel')
    const onInterrupt = (): void => stop(130, 'cancel')
    const onTerminate = (): void => stop(143, 'cancel')
    const onHangup = (): void => stop(129, 'cancel')
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
      if (!stopping) finish(127)
    })
    child.once('close', code => {
      childClosed = true
      if (!stopping) finish(code ?? 1)
      else if (treeTerminated) finish(stopCode)
      // Cancellation waits for tree termination, not merely the root's close.
    })
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    process.on('SIGHUP', onHangup)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    emit('start')
    deadline = setTimeout(() => stop(124, 'timeout'), timeoutMs)
    if (options.signal?.aborted) onAbort()
  })
}
