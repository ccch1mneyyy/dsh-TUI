/** Foreground shell seam across the legacy run() and 0.1.7 execute() APIs. */
export interface ShellRequest {
  command: string
  workdir?: string
  /** Foreground deadline in ms; omit for the executor's default (or, with
   *  `onExpiry: 'none'`, for no deadline at all). */
  timeoutMs?: number
  /** What happens when `timeoutMs` expires: `kill` stops the command
   *  (the default); `none` arms no deadline. */
  onExpiry?: 'kill' | 'none'
  /** Caller cancellation: executors kill the command tree when it fires. */
  signal?: AbortSignal
}

export interface ShellResult {
  stdout: { text: string }
  stderr: { text: string }
  timedOut: boolean
  /** True when the caller's signal (not the executor's timeout) cut the
   *  command short; absent on executors that do not report it. */
  aborted?: boolean
}

export interface ShellExecution {
  result(): Promise<ShellResult>
  /** Terminate the process tree; absent on handles that cannot be killed. */
  kill?(): boolean
}

export interface ForegroundShell {
  resolve(request: ShellRequest): unknown
  run?(spec: unknown): Promise<ShellResult>
  execute?(spec: unknown): Promise<ShellExecution>
}

/** A started foreground command: its result promise plus the levers the
 *  starter actually has over it on this host. */
export interface StartedShell {
  result: Promise<ShellResult>
  /** Best-effort termination (handle kill, when the handle has one). The
   *  request signal remains the primary lever; this covers executors whose
   *  resolved spec dropped it. False when nothing could be signalled. */
  kill(): boolean
  /** The deadline really is off (the resolved spec carries `onExpiry:
   *  'none'`); legacy hosts quietly keep their own foreground bound. */
  readonly unlimited: boolean
  /** The command can be stopped early (signal reached the spec or the
   *  execution handle can be killed). */
  readonly interruptible: boolean
}

/** Resolve through the host so workspace, timeout and sandbox policy survive. */
export function startForegroundShell(shell: ForegroundShell, request: ShellRequest): StartedShell {
  const spec = shell.resolve(request)
  if (typeof shell.execute === 'function') {
    const resolved = spec as { onExpiry?: unknown; signal?: unknown } | null
    const signalled = resolved !== null && typeof resolved === 'object' && resolved.signal === request.signal && request.signal !== undefined
    let handle: ShellExecution | undefined
    let killPending = false
    const execution = shell.execute(spec)
    void execution.then((started) => {
      handle = started
      if (killPending) started.kill?.()
    }, () => undefined)
    return {
      result: execution.then(started => started.result()),
      kill: () => {
        if (handle !== undefined) return handle.kill?.() ?? false
        killPending = true
        // The signal (when it reached the spec) is already doing this; the
        // pending kill only matters for handles that arrive killable.
        return signalled
      },
      unlimited: resolved !== null && typeof resolved === 'object' && resolved.onExpiry === 'none',
      get interruptible() { return signalled || handle?.kill !== undefined },
    }
  }
  if (typeof shell.run === 'function') {
    return { result: shell.run(spec), kill: () => false, unlimited: false, interruptible: false }
  }
  throw new Error('dsh-tui: shell provides neither execute() nor run()')
}

/** Resolve through the host so workspace, timeout and sandbox policy survive. */
export async function runForegroundShell(shell: ForegroundShell, request: ShellRequest): Promise<ShellResult> {
  return startForegroundShell(shell, request).result
}
