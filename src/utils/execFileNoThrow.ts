import { spawn } from 'node:child_process'
import { extname } from 'node:path'

const MAX_CAPTURE_BYTES = 64 * 1024

/** The settled outcome of a no-throw command run. */
export interface ExecFileNoThrowResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Options for {@link execFileNoThrow}: stdin payload, timeout, and child
 * working directory. */
export interface ExecFileNoThrowOptions {
  input?: string
  timeout?: number
  useCwd?: boolean
  cwd?: string
}

function appendBounded(chunks: Buffer[], chunk: Buffer, total: { value: number }): void {
  if (total.value >= MAX_CAPTURE_BYTES) return
  const remaining = MAX_CAPTURE_BYTES - total.value
  const part = chunk.subarray(0, remaining)
  chunks.push(part)
  total.value += part.length
}

/** Quote one argument for the Windows command interpreter without flattening
 * the caller's argv into an unquoted shell command. */
function quoteWindowsArg(value: string): string {
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')
  return `"${escaped.replace(/%/g, '%%')}"`
}

function spawnCommand(file: string, args: readonly string[], options?: ExecFileNoThrowOptions) {
  const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(extname(file))
  if (!isWindowsScript) return spawn(file, args, { timeout: options?.timeout, cwd: options?.cwd })
  const command = `"${[file, ...args].map(quoteWindowsArg).join(' ')}"`
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    timeout: options?.timeout,
    cwd: options?.cwd,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
}

/** Run a command without throwing; child output is bounded for safety. */
export function execFileNoThrow(
  file: string,
  args: readonly string[] = [],
  options?: ExecFileNoThrowOptions,
): Promise<ExecFileNoThrowResult> {
  return new Promise(resolve => {
    let child
    try {
      child = spawnCommand(file, args, options)
    } catch {
      resolve({ code: 1, stdout: '', stderr: '' })
      return
    }
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const stdoutTotal = { value: 0 }
    const stderrTotal = { value: 0 }
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    }
    child.stdout?.on('data', (chunk: Buffer) => appendBounded(stdoutChunks, chunk, stdoutTotal))
    child.stderr?.on('data', (chunk: Buffer) => appendBounded(stderrChunks, chunk, stderrTotal))
    child.stdin?.on('error', () => {})
    child.on('error', () => finish(1))
    child.on('close', code => finish(code))
    if (options?.input !== undefined) child.stdin?.write(options.input)
    child.stdin?.end()
  })
}
