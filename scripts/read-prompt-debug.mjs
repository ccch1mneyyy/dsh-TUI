#!/usr/bin/env node

/** Read the `/debug-prompt` snapshot as a prompt-oriented terminal report. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const input = resolve(process.argv[2] ?? '.dsh-prompt-debug.json')

function section(title, body) {
  return `${'-'.repeat(80)}\n${title}\n${'-'.repeat(80)}\n${body}`
}

function formatJson(value) {
  return JSON.stringify(value, null, 2)
}

function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '(none)'
  return messages.map((message, index) => {
    const role = typeof message?.role === 'string' ? message.role : 'unknown'
    return `[${index + 1}] ${role}\n${formatJson(message)}`
  }).join('\n\n')
}

function formatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '(none)'
  return tools.map((tool, index) => {
    const name = typeof tool?.name === 'string' ? tool.name : 'unknown'
    const description = typeof tool?.description === 'string' ? tool.description : '(none)'
    return [
      `[${index + 1}] ${name}`,
      `Description:\n${description}`,
      `Parameters:\n${formatJson(tool?.parameters ?? {})}`,
    ].join('\n')
  }).join('\n\n')
}

function formatRequest(request, index, total) {
  const context = request?.finalLlmContext
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error(`request ${index + 1} has no finalLlmContext object`)
  }

  const metadata = [
    `REQUEST ${index + 1}/${total}`,
    `Captured: ${request.capturedAt ?? 'unknown'}`,
    `Turn: ${request.turn ?? 'unknown'}`,
    `Step: ${request.step ?? 'unknown'}`,
    `Attempt: ${request.attempt ?? 'unknown'}`,
    `Request header: ${request.requestHeaderReason ?? '(unchanged)'}`,
    `Provider: ${context.provider ?? 'unknown'}`,
    `Model: ${context.model ?? 'unknown'}`,
    `Reasoning effort: ${context.reasoningEffort ?? '(default)'}`,
    `Max tokens: ${context.maxTokens ?? '(default)'}`,
    `Temperature: ${context.temperature ?? '(default)'}`,
    `Stop: ${context.stop === undefined ? '(none)' : formatJson(context.stop)}`,
  ].join('\n')

  return [
    '='.repeat(80),
    metadata,
    section('SYSTEM PROMPT', context.system ?? '(none)'),
    section(`TOOLS - TOP-LEVEL SCHEMAS (${Array.isArray(context.tools) ? context.tools.length : 0})`, formatTools(context.tools)),
    section(`MESSAGES - ORDERED CONVERSATION (${Array.isArray(context.messages) ? context.messages.length : 0})`, formatMessages(context.messages)),
  ].join('\n')
}

async function main() {
  let document
  try {
    document = JSON.parse(await readFile(input, 'utf8'))
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      throw new Error(`prompt debug file not found: ${input}\nRun /debug-prompt in dsh-tui first.`)
    }
    throw new Error(`cannot read prompt debug file ${input}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const turns = Array.isArray(document?.turns)
    ? document.turns
    : Array.isArray(document?.requests)
      ? [{ turn: document.turn, requests: document.requests }]
      : undefined
  if (turns === undefined || turns.some(turn => !Array.isArray(turn?.requests))) {
    throw new Error(`invalid prompt debug file: "turns[].requests" must be arrays (${input})`)
  }
  const requests = turns.flatMap(turn => turn.requests.map(request => ({
    ...request,
    ...(request.turn === undefined ? { turn: turn.turn } : {}),
  })))

  const header = [
    'DSH FINAL LLM CONTEXT',
    `File: ${input}`,
    `Session: ${document.sessionId ?? 'unknown'}`,
    `Turns: ${turns.length}`,
    `Requests: ${requests.length}`,
    `Capture started: ${document.captureStartedAt ?? '(legacy snapshot)'}`,
    `Generated: ${document.generatedAt ?? 'unknown'}`,
    'Sensitive: this output may contain conversation, workspace, and tool-result data.',
  ].join('\n')

  const report = requests.length === 0
    ? '(no requests)'
    : requests
      .map((request, index) => formatRequest(request, index, requests.length))
      .join('\n')
  process.stdout.write(`${header}\n\n${report}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
