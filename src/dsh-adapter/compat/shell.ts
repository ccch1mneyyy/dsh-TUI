/** Foreground shell seam across the legacy run() and 0.1.7 execute() APIs. */
export interface ShellRequest {
  command: string
  workdir?: string
  timeoutMs: number
}

export interface ShellResult {
  stdout: { text: string }
  stderr: { text: string }
  timedOut: boolean
}

export interface ForegroundShell {
  resolve(request: ShellRequest): unknown
  run?(spec: unknown): Promise<ShellResult>
  execute?(spec: unknown): Promise<{ result(): Promise<ShellResult> }>
}

/** Resolve through the host so workspace, timeout and sandbox policy survive. */
export async function runForegroundShell(shell: ForegroundShell, request: ShellRequest): Promise<ShellResult> {
  const spec = shell.resolve(request)
  if (typeof shell.execute === 'function') {
    const execution = await shell.execute(spec)
    return execution.result()
  }
  if (typeof shell.run === 'function') return shell.run(spec)
  throw new Error('dsh-tui: shell provides neither execute() nor run()')
}
