/** Official headless subprocess adapter. This directory alone owns DSH details. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { constants as osConstants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from '../../protocol.mjs'
import { startProcess, records, parseRecord } from '../../process.mjs'
import { locateDsh } from './locate.mjs'

const manager = fileURLToPath(new URL('./management-plugin.mjs', import.meta.url))
const validated = new Set(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5'])
const allowedEvents = new Set(['session', 'status', 'text', 'thinking', 'tool_call', 'tool_result', 'error', 'final'])

function requireContract(runtime) {
  // A new version is not proof of wire compatibility. Passthrough is ungated.
  if (!validated.has(runtime.version)) throw new CliError('ADAPTER_UNAVAILABLE', `This adapter validates DSH ${[...validated].join(', ')}; use dst dsh for another runtime`, 3)
}

/** Create the default adapter; host/process facilities are injectable in tests. */
export function createDshAdapter({ locate = locateDsh, start = startProcess, diagnostic = () => {} } = {}) {
  async function* perform(request, { signal }) {
    const runtime = locate(request)
    requireContract(runtime)
    signal.throwIfAborted()
    let directory
    let processRun
    let pendingFailure
    let completed = false
    try {
      directory = await mkdtemp(join(tmpdir(), 'dst-cli-'))
      const patches = []
      if (request.kind !== 'run') {
        patches.push({ id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true })
        patches.push({ insert: [{ id: 'dst-cli-management', name: manager, config: { request } }] })
      } else if (request.model) {
        patches.push({ id: 'agent-default-model', config: { provider: request.provider, model: request.model } })
      }
      const overlay = join(directory, 'cli.patch.json')
      await writeFile(overlay, JSON.stringify(patches), { mode: 0o600 })
      const args = [runtime.path, '--profile', request.profile]
      for (const patch of request.patches) args.push('--patch', patch)
      args.push('--patch', overlay, '--')
      if (request.kind === 'run') {
        args.push('--json')
        if (request.sessionId) args.push('--session-id', request.sessionId)
        args.push('-') // Prompt travels through stdin, never a command or process argv.
      }
      const env = { ...process.env }
      if (request.permission) env.DSH_PERMISSION_MODE = request.permission
      processRun = start({ command: process.execPath, args, cwd: request.cwd, env, input: request.kind === 'run' ? request.prompt : '' }, signal, diagnostic)
      for await (const line of records(processRun.child.stdout)) {
        const event = parseRecord(line)
        if (request.kind === 'run') {
          if (!allowedEvents.has(event.type)) throw new CliError('PROTOCOL_ERROR', 'Unsupported DSH headless event; adapter update required', 4)
        } else if (event.schemaVersion !== 1 || !['final', 'error'].includes(event.type)) {
          throw new CliError('PROTOCOL_ERROR', 'Management plugin protocol mismatch', 4)
        }
        if (event.type === 'status' && event.phase === 'turn_end') completed = event.reason?.kind === 'completed'
        if (event.type === 'error') {
          const code = ['SESSION_NOT_FOUND', 'PROVIDER_NOT_FOUND', 'CAPABILITY_UNAVAILABLE'].includes(event.code) ? event.code : 'TASK_FAILED'
          pendingFailure = new CliError(code, 'DSH could not complete the requested operation', code === 'TASK_FAILED' ? 1 : 3)
          yield { type: 'error', code, message: pendingFailure.message }
        } else if (event.type === 'final') yield { ...event, ok: request.kind !== 'run' || completed }
        else yield event
      }
      const exit = await processRun.settled
      signal.throwIfAborted()
      if (exit.drainFailed) throw new CliError('PROTOCOL_ERROR', 'Backend descendants did not release output pipes', 4)
      if (exit.error) throw new CliError('ADAPTER_UNAVAILABLE', 'Unable to start the DSH process', 3)
      if (exit.signal || exit.code !== 0) throw pendingFailure ?? new CliError('TASK_FAILED', `DSH exited unsuccessfully (${exit.code}); no operation was retried`, 1)
      if (pendingFailure) throw pendingFailure
    } finally {
      if (processRun) {
        processRun.stop()
        await processRun.settled
      }
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
  return {
    id: 'dsh-headless',
    async capabilities(request) {
      const runtime = locate(request)
      return {
        adapter: 'dsh-headless', runtimeVersion: runtime.version,
        validated: validated.has(runtime.version),
        operations: ['run', 'session.list', 'session.show', 'session.export', 'continue', 'models.list', 'skills.list', 'mcp.status', 'auth.status', 'dsh'],
        output: ['text', 'json', 'stream-json'],
        limits: { inputBytes: 8 * 1024 * 1024, recordBytes: 32 * 1024 * 1024 },
        limitations: ['committed-message-stream-not-token-stream', 'official-headless-resume-restrictions', 'profile-not-tui-preferences', 'mcp-registered-tools-not-connection-health', 'no-credential-values-or-login', 'profile-code-is-trusted'],
      }
    },
    execute: perform,
    async continueSession(request, context) {
      let id
      for await (const event of perform({ ...request, kind: 'session', action: 'continue' }, context)) {
        if (event.type === 'final') id = event.data?.sessionId
      }
      if (typeof id !== 'string' || !id) throw new CliError('SESSION_NOT_FOUND', 'No compatible session exists in this cwd', 3)
      return id
    },
    async passthrough(request, { signal }) {
      const runtime = locate(request)
      const processRun = start({ command: process.execPath, args: [runtime.path, ...request.args], cwd: request.cwd, env: process.env, inherit: true }, signal)
      const exit = await processRun.settled
      signal.throwIfAborted()
      if (exit.error) throw new CliError('ADAPTER_UNAVAILABLE', 'Unable to start DSH', 3)
      return exit.signal ? 128 + (osConstants.signals[exit.signal] ?? 0) : exit.code
    },
  }
}
