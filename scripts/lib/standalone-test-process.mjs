/** Bounded process ownership for standalone acceptance tests. */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

const errorInfo = error => error ? { code: error.code, message: error.message } : null

/** The caller must supply its own still-running process, never a process name. */
export function terminateStandaloneTree(pid) {
  const started = performance.now()
  const report = result => ({ ...result, cleanupElapsedMs: Math.round(performance.now() - started) })
  if (!Number.isInteger(pid) || pid <= 0) return report({ status: null, error: { message: 'Missing owned process ID' } })
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot) return report({ status: null, error: { message: 'Missing Windows SystemRoot for taskkill' } })
    // Kill the tree while its root still exists. Killing the root first can
    // detach native tar and let it keep writing after a failed verification.
    const result = spawnSync(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true })
    return report({ status: result.status, signal: result.signal, error: errorInfo(result.error),
      stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
  }
  // Other platforms extract in-process; preserve the previous timeout signal.
  try { process.kill(pid, 'SIGTERM'); return report({ status: 0, error: null }) }
  catch (error) { return report({ status: null, error: errorInfo(error) }) }
}

/** Capture output until close; a timeout stops the Windows tree before its root. */
export async function runStandaloneProcess(file, args, { timeoutMs, maxBuffer = 4 * 1024 * 1024, ...options }) {
  let child
  try { child = spawn(file, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { return { stdout: '', stderr: '', status: null, signal: null, error } }
  return await new Promise(resolve => {
    const stdout = []
    const stderr = []
    let capturedBytes = 0
    let error
    let cleanup
    let closed = false
    let stopping = false
    let drainDeadline
    const live = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null
    const finish = (status, signal) => {
      if (closed) return
      closed = true
      clearTimeout(deadline)
      clearTimeout(drainDeadline)
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        status, signal, error, cleanup })
    }
    const stop = reason => {
      if (closed || stopping) return
      stopping = true
      error ??= reason
      cleanup = live() ? terminateStandaloneTree(child.pid) : { status: null, error: { message: 'Root exited before its output closed' } }
      // Give close/stdout/stderr events a bounded drain after the tree kill.
      drainDeadline = setTimeout(() => {
        if (closed) return
        cleanup.drainTimedOut = true
        if (live()) child.kill('SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref()
        finish(child.exitCode, child.signalCode)
      }, 5000)
    }
    const capture = chunks => data => {
      const remaining = Math.max(0, maxBuffer - capturedBytes)
      if (remaining > 0) chunks.push(data.subarray(0, remaining))
      capturedBytes += data.length
      if (capturedBytes > maxBuffer) stop(Object.assign(new Error(`Standalone output exceeded ${maxBuffer} bytes`), { code: 'ENOBUFS' }))
    }
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.stdout.once('error', stop)
    child.stderr.once('error', stop)
    child.once('error', value => { error ??= value })
    child.once('close', finish)
    const deadline = setTimeout(() => stop(Object.assign(new Error(`spawn ${file} ETIMEDOUT after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })), timeoutMs)
  })
}
