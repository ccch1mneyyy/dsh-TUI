/** Process ownership and bounded NDJSON framing. No backend or UI imports. */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { CliError } from './protocol.mjs'

export const MAX_RECORD_BYTES = 32 * 1024 * 1024

/** Start exactly one process; abort reaps its process tree before completion. */
export function startProcess(spec, signal, diagnostic = () => {}) {
  signal.throwIfAborted()
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd, env: spec.env, shell: false,
    detached: !spec.inherit && process.platform !== 'win32', windowsHide: true,
    stdio: spec.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  })
  let spawnError
  let escalation
  let drainDeadline
  let drainFailed = false
  let killer
  let closed = false
  child.stdin?.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') spawnError = error })
  if (spec.input !== undefined) child.stdin?.end(spec.input)
  else child.stdin?.end()
  const kill = force => {
    if (closed || child.pid === undefined) return
    if (process.platform === 'win32') {
      // Node's Windows kill is not a cooperative signal. Own the exact tree.
      if (killer === undefined) {
        const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        killer = spawn(command, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        killer.once('error', () => { child.kill('SIGKILL') })
        killer.once('exit', code => { if (code !== 0 && !closed) child.kill('SIGKILL') })
      } else if (force) child.kill('SIGKILL')
    } else {
      try {
        if (spec.inherit) child.kill(force ? 'SIGKILL' : 'SIGTERM')
        else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM')
      }
    }
  }
  const abort = () => {
    if (closed) return
    kill(false)
    escalation ??= setTimeout(() => kill(true), 5000)
  }
  const completion = new Promise(resolve => {
    child.once('error', error => { spawnError = error })
    child.once('exit', () => {
      // A descendant holding inherited pipes must not keep a finished run alive.
      drainDeadline = setTimeout(() => {
        if (closed) return
        drainFailed = true
        kill(true)
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, 2000)
    })
    child.once('close', (code, exitSignal) => {
      closed = true
      signal.removeEventListener('abort', abort)
      clearTimeout(escalation)
      clearTimeout(drainDeadline)
      resolve({ code: code ?? 1, signal: exitSignal, error: spawnError, drainFailed })
    })
  })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const stderr = child.stderr === null ? Promise.resolve() : (async () => {
    const decoder = new StringDecoder('utf8')
    for await (const chunk of child.stderr) diagnostic(decoder.write(chunk))
    const tail = decoder.end()
    if (tail) diagnostic(tail)
  })().catch(error => { spawnError ??= error; abort() })
  // Observe both owned promises even when parsing or a consumer fails.
  const settled = Promise.all([completion, stderr]).then(async ([result]) => {
    if (killer && killer.exitCode === null && killer.signalCode === null) await new Promise(resolve => killer.once('close', resolve))
    return result
  })
  settled.catch(() => {})
  return { child, settled, stop: abort }
}

/** Complete newline-delimited records, including UTF-8 split across buffers. */
export async function* records(stream, maxBytes = MAX_RECORD_BYTES) {
  let parts = []
  let bytes = 0
  for await (const chunk of stream) {
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue
      const part = chunk.subarray(start, index)
      if (bytes + part.length > maxBytes) throw new CliError('OUTPUT_LIMIT', 'Backend record exceeds the CLI byte limit', 4)
      parts.push(part)
      const line = Buffer.concat(parts).toString('utf8').replace(/\r$/u, '')
      parts = []
      bytes = 0
      start = index + 1
      if (line !== '') yield line
    }
    const tail = chunk.subarray(start)
    bytes += tail.length
    if (bytes > maxBytes) throw new CliError('OUTPUT_LIMIT', 'Backend record exceeds the CLI byte limit', 4)
    if (tail.length) parts.push(tail)
  }
  if (bytes > 0) throw new CliError('PROTOCOL_ERROR', 'Backend ended with an incomplete JSONL record', 4)
}

export function parseRecord(line) {
  try {
    const value = JSON.parse(line)
    if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw new Error('record')
    return value
  } catch { throw new CliError('PROTOCOL_ERROR', 'Backend returned an invalid JSONL record', 4) }
}
