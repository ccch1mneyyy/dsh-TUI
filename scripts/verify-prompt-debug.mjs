/**
 * Regression for `/debug-prompt`: final AgentLoop requests across turns and
 * retry attempts must land in one private workspace file, while auxiliary
 * calls and transport-only fields stay out.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { PROMPT_DEBUG_FILENAME, registerPromptDebug } from '../lib/types/dsh-adapter/promptDebug.js'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-tui-prompt-debug-'))
const sessionId = 'prompt-debug-session'
const events = [
  { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: Date.now(), data: { turn: 1, step: 0 } },
]
const agent = {
  id: sessionId,
  session: {
    id: sessionId,
    header: { id: sessionId, cwd: workspace },
    events,
  },
}

let definition
let streamHandler
let disposedHandler
let nextCalls = 0
const ctx = {
  get(name) {
    if (name === 'commands') {
      return {
        register(value) {
          definition = value
          return () => {}
        },
      }
    }
    if (name === 'agents') return { get: id => String(id) === sessionId ? agent : undefined }
    if (name === 'llm') return {}
    return undefined
  },
  on(name, handler) {
    if (name === 'llm/stream') streamHandler = handler
    if (name === 'agent/disposed') disposedHandler = handler
    return () => {}
  },
  effect(factory) {
    return factory()
  },
}

async function dispatch(request) {
  const stream = streamHandler(request, () => {
    nextCalls += 1
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
  for await (const _chunk of stream) {
    // Consume the waterfall result so this exercises the same delegation
    // contract as LlmRuntime.stream().
  }
}

try {
  registerPromptDebug(ctx)
  assert.equal(definition?.name, 'debug-prompt')
  assert.equal(typeof streamHandler, 'function')
  assert.equal(typeof disposedHandler, 'function')

  await dispatch({
    provider: 'auxiliary',
    model: 'title-model',
    purpose: 'session-title',
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'make a title' }] }],
  })

  events.push({
    type: 'request/header',
    seq: 2,
    time: Date.now(),
    data: { reason: 'initial', header: {} },
  })
  await dispatch(markAgentLoopRequest({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId,
    system: 'final force-smart bootstrap prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the repository' }] }],
    tools: [{
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
    maxTokens: 1024,
    signal: new AbortController().signal,
    apiKey: 'must-not-be-written',
  }))

  events.push({
    type: 'request/header',
    seq: 3,
    time: Date.now(),
    data: { reason: 'change', header: {} },
  })
  await dispatch(markAgentLoopRequest({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId,
    system: 'final promoted prompt',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'inspect the repository' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }] },
      { role: 'tool', content: [{ type: 'tool-result', callId: 'call-1', content: [{ type: 'text', text: workspace }] }] },
    ],
    tools: [{
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
    maxTokens: 256000,
  }))
  events.push({ type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })

  const result = await definition.handler({ agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  // Success copy is localized (i18n prompt-debug-saved) and t() resolves the
  // language from env/locale, so accept either shipped language here.
  assert.match(result.text, /Wrote 2 final LLM request snapshots|已写入 2 条最终 LLM 请求快照/)
  // The reminder the security fix appends must survive in both languages.
  assert.match(result.text, /workspace|工作区/)
  assert.equal(nextCalls, 3, 'the capture hook must always delegate to the next waterfall listener')

  const output = join(workspace, PROMPT_DEBUG_FILENAME)
  const document = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(document.schemaVersion, 2)
  assert.equal(document.sessionId, sessionId)
  assert.equal(document.turnCount, 1)
  assert.equal(document.requestCount, 2)
  assert.equal(document.turns[0].turn, 1)
  assert.equal(document.turns[0].requestCount, 2)
  assert.deepEqual(document.turns[0].requests.map(request => request.attempt), [1, 2])
  assert.deepEqual(document.turns[0].requests.map(request => request.step), [0, 0])
  assert.deepEqual(document.turns[0].requests.map(request => request.requestHeaderReason), ['initial', 'change'])
  assert.equal(document.turns[0].requests[0].finalLlmContext.system, 'final force-smart bootstrap prompt')
  assert.equal(document.turns[0].requests[0].finalLlmContext.tools[0].parameters.type, 'object')
  assert.equal(document.turns[0].requests[1].finalLlmContext.system, 'final promoted prompt')
  assert.equal(document.turns[0].requests[1].finalLlmContext.messages[2].content[0].content[0].text, workspace)
  assert.equal(JSON.stringify(document).includes('must-not-be-written'), false)
  assert.equal(JSON.stringify(document).includes('session-title'), false)
  assert.equal('signal' in document.turns[0].requests[0].finalLlmContext, false)
  if (process.platform !== 'win32') {
    assert.equal(statSync(output).mode & 0o777, 0o600)
  }

  const readable = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'read-prompt-debug.mjs'), output], {
    encoding: 'utf8',
  })
  assert.equal(readable.status, 0, readable.stderr)
  assert.match(readable.stdout, /DSH FINAL LLM CONTEXT/)
  assert.match(readable.stdout, /REQUEST 1\/2/)
  assert.match(readable.stdout, /Turn: 1\nStep: 0\nAttempt: 1/)
  assert.match(readable.stdout, /SYSTEM PROMPT\n-{80}\nfinal force-smart bootstrap prompt/)
  assert.match(readable.stdout, /TOOLS - TOP-LEVEL SCHEMAS \(1\)/)
  assert.match(readable.stdout, /MESSAGES - ORDERED CONVERSATION \(3\)/)
  assert.ok(
    readable.stdout.indexOf('TOOLS - TOP-LEVEL SCHEMAS')
      < readable.stdout.indexOf('MESSAGES - ORDERED CONVERSATION'),
  )
  assert.match(readable.stdout, /"type": "object"/)

  events.push({ type: 'turn/start', seq: 5, time: Date.now(), data: { turn: 2 } })
  events.push({ type: 'step/start', seq: 6, time: Date.now(), data: { turn: 2, step: 0 } })
  await dispatch(markAgentLoopRequest({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    sessionId,
    system: 'latest smart prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'second turn' }] }],
  }))
  events.push({ type: 'turn/end', seq: 7, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } })
  await definition.handler({ agent, rawInput: '', signal: new AbortController().signal })
  const latest = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(latest.turnCount, 2)
  assert.equal(latest.requestCount, 3, 'all observed turns are retained')
  assert.deepEqual(latest.turns.map(turn => turn.turn), [1, 2])
  assert.equal(latest.turns[1].requestCount, 1)
  assert.equal(latest.turns[1].requests[0].attempt, 1)
  assert.equal(latest.turns[1].requests[0].finalLlmContext.system, 'latest smart prompt')

  const usage = await definition.handler({ agent, rawInput: ' on', signal: new AbortController().signal })
  assert.deepEqual(usage, { kind: 'error', text: 'Usage: /debug-prompt' })

  console.log('prompt debug OK (final context, turn/step/retry retention, filtering, permissions)')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
