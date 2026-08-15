import { spawn } from 'node:child_process'

/** The settled outcome of a no-throw command run. */
export interface ExecFileNoThrowResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Options for {@link execFileNoThrow}: stdin payload, timeout, and child
 * working directory.
 */
export interface ExecFileNoThrowOptions {
  /** Stdin payload (OSC 52 clipboard helpers and tmux load-buffer). */
  input?: string
  /** Kill the child after this many milliseconds. */
  timeout?: number
  /**
   * Accepted for call-site compatibility with the original execa-based
   * implementation; `false` (the only value the Ink core passes) matches this
   * shim's behavior of running in the current working directory.
   */
  useCwd?: boolean
  /** Working directory for the child; defaults to the parent's cwd. */
  cwd?: string
}

/**
 * Run a command without throwing: resolves with `{ code, stdout, stderr }`
 * even when the process exits non-zero or cannot spawn.
 * @param file - The executable path to spawn.
 * @param args - Command-line arguments; defaults to none.
 * @param options - Spawn options (input, timeout, cwd).
 * @returns The process outcome: exit code, captured stdout, and captured stderr.
 */
export function execFileNoThrow(
  file: string,
  args?: readonly string[],
  options?: ExecFileNoThrowOptions,
): Promise<ExecFileNoThrowResult> {
  return new Promise(resolve => {
    const child = spawn(file, args ?? [], { timeout: options?.timeout, cwd: options?.cwd })
    // Collect raw bytes and decode once at close: per-chunk toString() splits
    // multi-byte UTF-8 characters straddling a chunk boundary into U+FFFD.
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })
    child.on('error', () => {
      resolve({
        code: 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
    child.on('close', code => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
    if (options?.input !== undefined) child.stdin.write(options.input)
    child.stdin.end()
  })
}
