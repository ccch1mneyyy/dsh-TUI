/** Pure command orchestration. Adapter selection belongs to entry.mjs only. */
import { CliError, envelope, failure } from './protocol.mjs'

const MAX_INPUT_BYTES = 8 * 1024 * 1024

async function inputText(input, signal) {
  if (input.isTTY) return ''
  signal.throwIfAborted()
  const abort = () => input.destroy(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  let bytes = 0
  const chunks = []
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_INPUT_BYTES) throw new CliError('INPUT_LIMIT', 'Piped input exceeds 8 MiB', 2)
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { signal.removeEventListener('abort', abort) }
}

async function write(output, text, signal) {
  signal?.throwIfAborted()
  await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    output.write(text, error => {
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    })
  })
}

/** Execute with a preselected adapter. No retry, UI bootstrap or fallback. */
export async function execute(request, adapter, io, signal) {
  if (request.kind === 'dsh') return adapter.passthrough(request, { signal })
  if (request.kind === 'capabilities') {
    const data = await adapter.capabilities(request, { signal })
    await write(io.stdout, `${JSON.stringify(envelope('capabilities', data), null, request.output === 'text' ? 2 : undefined)}\n`, signal)
    return 0
  }
  if (request.kind === 'run') {
    const piped = await inputText(io.stdin, signal)
    const prompt = request.prompt === '-' ? '' : request.prompt
    const task = [prompt, piped].filter(part => part !== '').join('\n\n')
    if (task.trim() === '') throw new CliError('INVALID_ARGUMENT', 'A prompt or piped UTF-8 input is required', 2)
    request = { ...request, prompt: task }
    if (request.continue) request.sessionId = await adapter.continueSession(request, { signal })
  }
  let final
  let sessionId
  let backendError = false
  for await (const event of adapter.execute(request, { signal })) {
    signal.throwIfAborted()
    if (event.type === 'session') {
      if (sessionId !== undefined || typeof event.sessionId !== 'string' || !event.sessionId) throw new CliError('PROTOCOL_ERROR', 'Invalid or duplicate session event', 4)
      sessionId = event.sessionId
    }
    if (final !== undefined) throw new CliError('PROTOCOL_ERROR', 'Backend emitted events after its final result', 4)
    if (event.type === 'error') backendError = true
    if (event.type === 'final') {
      if (request.kind === 'run' && typeof event.text !== 'string') throw new CliError('PROTOCOL_ERROR', 'Missing final answer text', 4)
      final = event
      continue // Never publish a success until process exit/cleanup is verified.
    }
    if (request.output === 'stream-json') await write(io.stdout, `${JSON.stringify(envelope(event.type, { ...event, schemaVersion: 1 }))}\n`, signal)
  }
  signal.throwIfAborted()
  if (final === undefined) throw new CliError('PROTOCOL_ERROR', 'Backend exited without a final result', 4)
  if (backendError || final.ok !== true || (request.kind === 'run' && sessionId === undefined)) throw new CliError('PROTOCOL_ERROR', 'Backend success disagrees with its committed outcome', 4)
  const result = envelope('result', request.kind === 'run'
    ? { ok: true, sessionId, text: final.text }
    : { ok: true, data: final.data })
  if (request.output === 'text') {
    const text = request.kind === 'run' ? final.text
      : typeof final.data === 'string' ? final.data : JSON.stringify(final.data, null, 2)
    await write(io.stdout, `${text}\n`, signal)
  } else await write(io.stdout, `${JSON.stringify(result)}\n`, signal)
  return 0
}

export async function reportFailure(error, request, io, signal) {
  if (error?.code === 'EPIPE') return 1
  const exitCode = error instanceof CliError ? error.exitCode : 1
  const payload = failure(error)
  if (request?.output === 'json') await write(io.stdout, `${JSON.stringify(envelope('result', { ok: false, error: payload, exitCode }))}\n`, signal)
  else if (request?.output === 'stream-json') await write(io.stdout, `${JSON.stringify(envelope('error', { ...payload, exitCode }))}\n`, signal)
  else await write(io.stderr, `dst: ${payload.code}: ${payload.message}\n`, signal)
  return exitCode
}
