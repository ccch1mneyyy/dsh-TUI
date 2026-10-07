/**
 * Optional catalog archive semantics through the production channel and real
 * SessionSupervisor. Drives stdin into an in-memory terminal; no credentials.
 * Run: node --import tsx/esm scripts/verify-session-archive.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import type { AgentSession } from '../src/agent/session.js'
import type { SessionCatalog } from '../src/agent/backend.js'
import type { SessionSummary } from '../src/adapter/ports/channel-session.js'
import type { SupervisorLiveState } from '../src/screens/sessionSupervisor/model.js'
import { settled, viewportLines } from './lib/term-test.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-archive-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
const [{ createChannel }, { channelCapabilities }, { SessionSupervisor }, { render, ThemeProvider, AlternateScreen }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/capabilities.js'),
  import('../src/screens/SessionSupervisor.js'),
  import('../src/ui.js'),
])
const { Terminal: XTerm } = xterm
class Output extends Writable {
  isTTY = true
  constructor(readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void { this.terminal.write(String(chunk), done) }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}
const context = { on: () => () => undefined, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } } as never
const agent = (): AgentSession => ({
  ref: { backendId: 'fixture', sessionId: 'live' }, cwd: home, status: 'idle', capabilities: { native: {} },
  history: async () => [], subscribe: () => () => undefined, submit: async () => ({ accepted: true }),
  cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => undefined,
})
const summary = (): SessionSummary => ({
  id: 'stored', backendId: 'fixture', kind: { kind: 'root' }, title: { text: 'stored conversation', source: 'prompt' },
  cwd: home, createdAt: 1, updatedAt: 2, bytes: undefined, hasPrompt: true,
  agentPreset: undefined, model: undefined, label: undefined, branch: undefined, childCount: 0,
})
let passed = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }

async function browser(archive: boolean, failure = false, current = false) {
  let listed = true
  let kept = true
  let calls = 0
  const catalog: SessionCatalog = {
    ...(archive ? { deleteAction: 'archive' as const } : {}),
    list: async () => listed ? [summary()] : [],
    delete: async id => {
      calls += 1
      assert.equal(id, 'stored')
      if (failure) throw new Error('fixture removal failed')
      listed = false
      if (!archive) kept = false
    },
  }
  const channel = createChannel(context, agent(), { model: 'fixture', provider: '', cwd: home, activity: false, initialHistory: [], sessionCatalog: catalog, openSession: async () => agent() })
  const terminal = new XTerm({ cols: 130, rows: 28, scrollback: 0, allowProposedApi: true })
  const input = new Input()
  const output = new Output(terminal)
  const app = await render(<ThemeProvider theme="dark"><AlternateScreen><SessionSupervisor
    channel={channel} home={home} onClose={() => {}} onOpenSession={async () => ({ ok: true })}
    onNewSession={async () => true} onStopSession={async () => true} approval={null} onApprove={() => {}}
    liveStateOf={() => current ? { live: true, current: true, status: 'idle', summary: '' } as SupervisorLiveState : undefined}
  /></AlternateScreen></ThemeProvider>, { stdin: input as never, stdout: output as never, stderr: output as never, exitOnCtrlC: false, patchConsole: false })
  const text = () => viewportLines(terminal).join('\n')
  const appears = (needle: string) => settled(() => text().includes(needle))
  return { channel, text, appears, write: (bytes: string) => input.write(bytes), get calls() { return calls }, get kept() { return kept }, close() { app.unmount(); terminal.dispose(); input.destroy(); output.destroy(); channel.releaseContributions() } }
}

try {
  for (const archive of [true, false]) {
    const screen = await browser(archive)
    const verb = archive ? 'Archive' : 'Delete'
    try {
      check(verb + ': catalog metadata reaches the capability snapshot without an id branch', screen.channel.backendCapabilities.deleteAction === (archive ? 'archive' : undefined))
      check(verb + ': native stored conversation appears in the real browser', await screen.appears('stored conversation'))
      const focused = (label: string) => screen.text().split('\n').some(line => line.includes('❯') && line.includes(label))
      screen.write('\u001b[C')
      check('keyboard focus reaches the session column', await settled(() => focused('+ New session') || focused('stored conversation')))
      if (!focused('stored conversation')) screen.write('\u001b[B')
      check('keyboard focus reaches the stored row', await settled(() => focused('stored conversation')))
      check(verb + ': action hint uses the actual removal semantics', await screen.appears(archive ? 'Ctrl+D archive' : 'Ctrl+D delete'))
      screen.write('\u0004')
      check(verb + ': confirmation uses the catalog action', await screen.appears(verb + ' session stored conversation?'))
      check(verb + ': confirmation accurately states transcript retention', screen.text().includes(archive ? 'native transcript is kept' : 'transcript is removed from disk'))
      screen.write('\u001b')
      check(verb + ': cancelling confirmation does not reach the catalog', await settled(() => !screen.text().includes(verb + ' session stored conversation?')) && screen.calls === 0)
      screen.write('\u0004')
      check(verb + ': confirmation can reopen', await screen.appears(verb + ' session stored conversation?'))
      screen.write('\r')
      check(verb + ': completion notice names the right action', await screen.appears(archive ? 'Archived session stored conversation' : 'Deleted session stored conversation'))
      check(verb + ': removal is delegated once with the documented retention', screen.calls === 1 && screen.kept === archive)
    } finally { screen.close() }
  }
  for (const current of [false, true]) {
    const screen = await browser(true, !current, current)
    try {
      check('archive refusal fixture paints the session', await screen.appears('stored conversation'))
      const focused = (label: string) => screen.text().split('\n').some(line => line.includes('❯') && line.includes(label))
      screen.write('\u001b[C')
      check('keyboard focus reaches the session column', await settled(() => focused('+ New session') || focused('stored conversation')))
      if (!focused('stored conversation')) screen.write('\u001b[B')
      check('keyboard focus reaches the stored row', await settled(() => focused('stored conversation')))
      screen.write('\u0004')
      check('archive refusal requests confirmation', await screen.appears('Archive session stored conversation?'))
      screen.write('\r')
      check(current ? 'current-session archive refusal uses archive copy' : 'backend archive failure never says deleted', await screen.appears(current ? 'cannot be archived' : 'Could not archive stored conversation'))
      check('refused archive retains the transcript', screen.kept && screen.calls === (current ? 0 : 1))
    } finally { screen.close() }
  }
  const dsh = channelCapabilities({ backendId: 'dsh', backendLabel: 'DSH', capabilities: { native: {} }, dsh: true, deleteAction: 'archive' })
  check('DSH ignores another catalog’s optional archive annotation', dsh.deleteAction === undefined)
} finally { rmSync(home, { recursive: true, force: true }) }
console.log('verify-session-archive: ' + passed + ' PASS')
