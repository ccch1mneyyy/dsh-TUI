/** #1773: kernel terminal refusals must have a complete localized recovery
 * report, without changing policy, closing shells, or reaching the model.
 * Run after compile: node scripts/verify-mode-terminal-feedback.mjs
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import React from 'react'
import { Writable, PassThrough } from 'node:stream'
import xterm from '@xterm/headless'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { createModeActions, reportModeSwitchFailure } from '../lib/types/dsh-adapter/channel/mode-actions.js'
import { createExternalCommandInvoker } from '../lib/types/dsh-adapter/channel/external-commands.js'
import { createPermissionIdentity } from '../lib/types/dsh-adapter/channel/mode-permission.js'
import { setLang, t } from '../lib/types/i18n.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { QuestionStore } from '../lib/types/dsh-adapter/questions.js'
import * as ui from '../lib/types/ui.js'

process.env.DSH_TUI_NO_185_PROCESS_GUARD = '1'
const { Terminal } = xterm
const refusal = 'cannot change sandbox mode from "workspace-write" to "read-only" while persistent terminal sessions are open or being created; wait for creation to settle and close them first'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++ }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function settle(predicate) {
  const end = Date.now() + 5000
  while (!predicate() && Date.now() < end) await sleep(20) // 固定窗:pacing Poll bounded render readiness, not a performance measurement.
  assert.ok(predicate(), 'bounded render/input deadline')
}

for (const lang of ['zh', 'en']) {
  setLang(lang)
  const reports = [], notices = [], logs = []
  let refreshed = 0
  reportModeSwitchFailure({ logger: { warn: value => logs.push(value) } },
    text => notices.push(text), () => refreshed++, new Error(refusal), (...args) => reports.push(args))
  check(`${lang} mode refusal has one complete local report`, reports.length === 1 && reports[0][1].join('\n').includes('/new'))
  check(`${lang} concise localized toast replaces raw English`, notices.length === 1 && !notices[0].includes('cannot change sandbox'))
  check(`${lang} original diagnostic and durable refresh retained`, logs[0].includes(refusal) && refreshed === 1)
  const count = reports.length
  reportModeSwitchFailure({ logger: { warn() {} } }, () => {}, () => { throw Error('fold failed') }, 'disk full', (...args) => reports.push(args))
  check(`${lang} unrelated errors never get terminal advice and refresh failure stays soft`, reports.length === count)
  const events = [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }]
  const agent = { session: { events, append() { throw new Error(refusal) } } }
  const modes = [{ id: 'default', sandbox: 'workspace-write' }, { id: 'read', sandbox: 'read-only' }]
  const state = { mode: modes[0], modeIndex: 0, emit() {} }
  const actions = createModeActions({ get() {}, logger: { warn() {} } }, state, {
    owner: { current: () => true }, runtime: { mode: 'legacy', slices: [] },
    binding: { agent, capture: () => ({ agent }), isCurrent: () => true }, sessionModes: modes,
    executeRegistryCommand: async () => undefined, notify() {}, pushLocal: (...args) => reports.push(args),
  })
  await actions.applyMode(modes[1])
  check(`${lang} actual atom refusal reports and keeps the confirmed mode`, reports.length === count + 1 && state.mode === modes[0] && events.length === 1)
}

for (const [name, kind, text, thrown, expected] of [
  ['permission', 'error', refusal, false, true],
  ['permission', 'error', refusal, true, true],
  ['plan', 'error', refusal, false, true],
  ['plan', 'error', refusal, true, true],
  ['other', 'error', refusal, false, false],
  ['permission', 'success', refusal, false, false],
  ['permission', 'error', refusal + ' (different error)', false, false],
]) {
  const reports = []
  const definition = { name }
  const invoker = createExternalCommandInvoker({ get() {}, logger: { warn() {} } }, {
    commandService: { find: () => definition, async execute() { if (thrown) throw new Error(text); return { result: { kind, text } } } },
    runtime: { mode: 'legacy', slices: [] }, agent: () => ({}), capture: () => 'origin', bindingCurrent: () => true,
    allows: () => true, composer: { snapshot: () => new Map(), includeLegacyImageRefs: (_line, refs) => refs },
    attachments: () => undefined, notify() {}, pushLocal: (...args) => reports.push(args),
  })
  const outcome = await invoker.invoke(name, '')
  const label = `${name} ${kind} ${thrown ? 'thrown' : 'settled'} ${text === refusal ? 'exact' : 'near-match'}`
  check(`${label} only recognized failures produce a report`, reports.length === (expected ? 1 : 0))
  check(`${label} preserves error/success and draft-consumption semantics`, outcome.kind === kind && outcome.consumeDraft === !thrown)
  check(`${label} keeps unrelated/success text verbatim`, expected ? outcome.text !== text : outcome.text === text)
}

// A rejected registry promise can finish after /new. Its report must never
// enter the replacement channel, even if the text matches the kernel guard.
{
  let live = true, reject, started
  const ready = new Promise(resolve => { started = resolve })
  const reports = []
  const definition = { name: 'permission' }
  const invoker = createExternalCommandInvoker({ get() {}, logger: { warn() {} } }, {
    commandService: { find: () => definition, execute() { started(); return new Promise((_, fail) => { reject = fail }) } },
    runtime: { mode: 'legacy', slices: [] }, agent: () => ({}), capture: () => 'origin', bindingCurrent: () => live,
    allows: () => true, composer: { snapshot: () => new Map(), includeLegacyImageRefs: (_line, refs) => refs },
    attachments: () => undefined, notify() {}, pushLocal: (...args) => reports.push(args),
  })
  const pending = invoker.invoke('permission', ' read-only')
  await Promise.race([ready, sleep(5000).then(() => { throw Error('registry execution was not reached') })]) // 固定窗:墙钟 Missing execution is a bounded fixture failure.
  live = false
  reject(new Error(refusal))
  await pending
  check('late rejected command cannot append a report to another binding', reports.length === 0)
}

for (const kind of ['error', 'success']) {
  const events = []
  const agent = { session: { events } }
  let typedCalls = 0, legacyCalls = 0
  const notices = []
  const permission = createPermissionIdentity({ logger: { warn() {} } }, {
    agent: () => agent, roster: { readSnapshot: () => undefined }, commandService: { find: () => ({}) },
    executeRegistryCommand: async () => { legacyCalls++; return 'wrong path' },
    executeRegistryCommandOutcome: async () => {
      typedCalls++
      if (kind === 'success') events.push({ type: 'permission/preset', data: { preset: 'read-only' } })
      // Deliberately collide with the localized error summary: result kind,
      // not the display text, decides whether confirmation can succeed.
      return { kind, text: t('mode-terminal-blocked'), consumeDraft: true }
    }, notify: text => notices.push(text),
  })
  const result = await permission.applyPermissionIdentity('read-only')
  check(`typed permission ${kind} ignores localized-text collisions`, result === (kind === 'success'))
  check(`typed permission ${kind} invokes exactly one command path`, typedCalls === 1 && legacyCalls === 0)
  check(`typed permission ${kind} reports only a real command failure`, notices.length === (kind === 'error' ? 1 : 0))
}

for (const fullscreen of [false, true]) for (const columns of [32, 80]) for (const lang of ['zh', 'en']) {
  setLang(lang)
  const durable = [], submitted = [], captures = []
  let calls = 0
  const definition = { name: 'permission', description: 'Permission mode', input: { hint: '', images: false } }
  const commands = {
    list: () => [definition], find: (_agent, name) => name === 'permission' ? definition : undefined,
    async execute() { calls++; return { commandId: 'permission', result: { kind: 'error', text: refusal } } },
  }
  const agent = { id: 'fixture', status: 'idle', session: { id: 'fixture', seq: 0, events: durable },
    ctx: { on: () => () => {} }, followup: input => submitted.push(input), steer() {}, cancel() {} }
  const ctx = { on: () => () => {}, get: name => name === 'commands' ? commands : undefined,
    logger: { warn() {}, info() {}, debug() {} } }
  const channel = createChannel(ctx, agent, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false })
  const terminal = new Terminal({ cols: columns, rows: 60, scrollback: 1000, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _encoding, callback) { captures.push(String(chunk)); terminal.write(String(chunk), callback) } })
  Object.assign(stdout, { columns, rows: 60, isTTY: true })
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } })
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  let app
  const screen = () => Array.from({ length: terminal.buffer.active.baseY + terminal.rows }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  try {
    const chat = React.createElement(Chat, { channel, fullscreen, questionStore: new QuestionStore(), onExit() {}, trajectorySeen: true })
    app = await ui.render(fullscreen ? React.createElement(ui.AlternateScreen, { mouseTracking: true }, chat) : chat,
      { stdout, stdin, stderr, patchConsole: false, exitOnCtrlC: false })
    await settle(() => screen().includes('fake-model'))
    for (const char of '/permission read-only') stdin.write(char)
    await settle(() => screen().includes('/permission read-only'))
    stdin.write('\r')
    await settle(() => calls === 1)
    const tail = lang === 'zh' ? '会话的全部终端，可重试切换。' : 'through the host, retry the switch.'
    await settle(() => screen().replace(/\s+/gu, '').includes(tail.replace(/\s+/gu, '')))
    const rows = channel.rows.filter(row => row.kind === 'local-output')
    check(`${fullscreen ? 'fullscreen' : 'inline'} ${columns} ${lang} actual slash dispatch publishes recovery report`, rows.length === 2 && rows[1].text.includes('/new'))
    const packed = screen().replace(/\s+/gu, '')
    check(`${fullscreen ? 'fullscreen' : 'inline'} ${columns} ${lang} full reason and recovery tail render without truncation`,
      rows.length === 2 && rows.every(row => packed.includes(row.text.replace(/\s+/gu, ''))))
    check(`${fullscreen ? 'fullscreen' : 'inline'} ${columns} ${lang} no model delivery or durable mutation`, submitted.length === 0 && durable.length === 0 && calls === 1)
    if (process.env.DSH_TUI_FEEDBACK_CAPTURE_DIR) {
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const name = `${fullscreen ? 'fullscreen' : 'inline'}-${columns}-${lang}`
      writeFileSync(join(process.env.DSH_TUI_FEEDBACK_CAPTURE_DIR, `${name}.screen.txt`), screen())
      writeFileSync(join(process.env.DSH_TUI_FEEDBACK_CAPTURE_DIR, `${name}.ansi`), captures.join(''))
    }
  } finally {
    if (app) await app.unmount()
    channel.releaseContributions()
    terminal.dispose()
    stdin.destroy()
  }
}
if (failures) process.exitCode = 1
console.log(`verify-mode-terminal-feedback: ${failures} failure(s)`)
