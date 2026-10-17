/** Composition root: the only module binding the engine to its default adapter. */
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse, help, errorFormat } from './args.mjs'
import { execute, reportFailure } from './engine.mjs'
import { CliError } from './protocol.mjs'
import { createDshAdapter } from './adapters/dsh/index.mjs'

/** Injectable adapter is an embedding/testing seam, not untrusted CLI code loading. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const io = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
  const controller = new AbortController()
  const abort = (code, message, exitCode) => controller.abort(new CliError(code, message, exitCode))
  const interrupt = () => abort('INTERRUPTED', 'Invocation interrupted', 130)
  const terminate = () => abort('TERMINATED', 'Invocation terminated', 143)
  const brokenPipe = error => { if (error.code === 'EPIPE') abort('BROKEN_PIPE', 'Output consumer closed the pipe', 1) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  io.stdout.on('error', brokenPipe)
  let timer
  let request = { output: errorFormat(argv) }
  try {
    request = parse(argv)
    if (request.help) { io.stdout.write(help()); return 0 }
    let directory
    try { directory = await stat(request.cwd) } catch { throw new CliError('INVALID_ARGUMENT', 'Working directory does not exist', 2) }
    if (!directory.isDirectory()) throw new CliError('INVALID_ARGUMENT', 'Working directory is not a directory', 2)
    if (request.timeout > 0) timer = setTimeout(() => abort('TIMEOUT', 'Invocation deadline exceeded', 124), request.timeout)
    return await execute(request, options.adapter ?? createDshAdapter(), io, controller.signal)
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error
    // A blocked downstream must not turn reporting a deadline into another
    // unbounded wait. No successful result is written through this path.
    const reporting = new AbortController()
    const reportTimer = setTimeout(() => reporting.abort(new CliError('OUTPUT_CLOSED', 'Error output did not drain', 1)), 1000)
    try { return await reportFailure(reason, request, io, reporting.signal) } catch { return reason instanceof CliError ? reason.exitCode : 1 }
    finally { clearTimeout(reportTimer) }
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    io.stdout.removeListener('error', brokenPipe)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main()
