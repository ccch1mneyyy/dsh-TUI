/**
 * The approval panel's option variants (docs/agent-backend-design.md §4.7),
 * rendered headless in both languages:
 *
 *  - no options (every DSH ask): exactly "1. allow once / 2. reject", the
 *    plain hint, and the DSH outcome strings — today's panel;
 *  - backend options: allow once / allow always (the backend's own label) /
 *    reject; a digit picks, Enter confirms, the decision names the option;
 *  - `defaultToNo`: the rejection comes first and is focused, and no digit
 *    approves;
 *  - `suppressAlwaysAllow` / a forcing ask rule: no allow-always row;
 *  - `feedback`: typing composes a reason shown on the rejection row; Enter
 *    sends it, Esc rejects without it; backspace edits it;
 *  - subagent and blocked-path lines; the DSH background and `[external]`
 *    lines are unchanged.
 *
 * Run: node --import tsx/esm scripts/verify-approval-panel-options.tsx
 */
import assert from 'node:assert/strict'

process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { render },
  { ApprovalPanel },
  { settled, sleep },
  { setLang, t },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/approvals/ApprovalPanel.js'),
  import('./lib/term-test.mjs'),
  import('../src/i18n.js'),
])
import type { PermissionPanelDecision, PermissionPanelOutcome, PermissionPanelSnapshot } from '../src/channel/permissions.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const COLS = 100
const ROWS = 30
const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    terminal.write(String(chunk), callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const screen = (): string => Array.from({ length: ROWS }, (_, y) =>
  terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')

const decisions: { outcome: PermissionPanelOutcome; decision: PermissionPanelDecision }[] = []
const onDecide = (outcome: PermissionPanelOutcome, decision: PermissionPanelDecision): void => { decisions.push({ outcome, decision }) }
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const backend: PermissionPanelSnapshot = {
  key: 'b1',
  toolName: 'Write',
  agentId: 'session-1',
  command: 'notes.txt',
  options: [
    { id: 'allow-once', kind: 'allow-once' },
    { id: 'allow-always', kind: 'allow-always', label: 'Yes, and auto-accept edits this session' },
    { id: 'reject', kind: 'reject' },
  ],
}
const app = await render(React.createElement(ApprovalPanel, { approval: { key: 'd1', toolName: 'Bash', agentId: 'session-1', command: 'rm -rf /tmp/x' }, onDecide }), {
  stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false,
})
const show = async (approval: PermissionPanelSnapshot): Promise<void> => {
  app.rerender(React.createElement(ApprovalPanel, { key: approval.key, approval, onDecide }))
  // 固定窗:pacing the remounted panel attaches its input handler on the next render tick.
  await sleep(60)
}
const press = async (input: string): Promise<void> => {
  stdin.write(input)
  // 固定窗:pacing one key event is applied before the next.
  await sleep(40)
}

try {
  for (const lang of ['zh', 'en'] as const) {
    setLang(lang)
    decisions.length = 0

    // ── DSH: no options → today's two rows ─────────────────────────
    await show({ key: `dsh-${lang}`, toolName: 'Bash', agentId: 'session-1', command: 'rm -rf /tmp/x' })
    check(`${lang}: no options → exactly allow once / reject`, await settled(() => screen().includes(`1. ${t('approval-yes')}`) && screen().includes(`2. ${t('approval-no')}`)) && !screen().includes('3. '), screen())
    check(`${lang}: the plain hint`, screen().includes(t('approval-hint')))
    await press('2')
    check(`${lang}: digit 2 → the DSH 'rejected' outcome`, decisions.at(-1)?.outcome === 'rejected' && decisions.at(-1)?.decision.optionId === 'reject')
    await show({ key: `dsh2-${lang}`, toolName: 'Bash', agentId: 'session-1' })
    await press('\r')
    check(`${lang}: Enter on the first row → 'allowed-once'`, decisions.at(-1)?.outcome === 'allowed-once')

    // ── backend options ────────────────────────────────────────────
    await show({ ...backend, key: `b-${lang}` })
    check(`${lang}: three backend rows with the backend's label`, await settled(() => screen().includes(`2. ${backend.options![1]!.label}`) && screen().includes(`3. ${t('approval-no')}`)), screen())
    await press('2')
    check(`${lang}: digit 2 → allow always, naming the option`, decisions.at(-1)?.outcome === 'allowed-always' && decisions.at(-1)?.decision.optionId === 'allow-always')
    await show({ ...backend, key: `b2-${lang}` })
    await press('\x1b[B')
    await press('\x1b[B')
    await press('\r')
    check(`${lang}: ↓↓ Enter → reject`, decisions.at(-1)?.outcome === 'rejected')

    // ── defaultToNo ────────────────────────────────────────────────
    await show({ ...backend, key: `n-${lang}`, defaultToNo: true })
    check(`${lang}: defaultToNo puts the rejection first`, await settled(() => screen().includes(`1. ${t('approval-no')}`)), screen())
    const before = decisions.length
    await press('2')
    await press('3')
    check(`${lang}: defaultToNo — no digit approves`, decisions.length === before)
    await press('\r')
    check(`${lang}: defaultToNo — Enter on the focused row rejects`, decisions.length === before + 1 && decisions.at(-1)?.outcome === 'rejected')

    // ── suppressed allow-always ────────────────────────────────────
    await show({ ...backend, key: `s-${lang}`, suppressAlwaysAllow: true })
    check(`${lang}: suppressAlwaysAllow hides allow-always`, await settled(() => screen().includes(`2. ${t('approval-no')}`) && !screen().includes(backend.options![1]!.label!)), screen())
    await show({ ...backend, key: `m-${lang}`, matchedAskRule: true })
    check(`${lang}: a forcing ask rule hides allow-always`, await settled(() => !screen().includes(backend.options![1]!.label!) && screen().includes(`2. ${t('approval-no')}`)), screen())
    const beforeDismiss = decisions.length
    await press('\x1b')
    await settled(() => decisions.length === beforeDismiss + 1)

    // ── feedback ───────────────────────────────────────────────────
    await show({ ...backend, key: `f-${lang}`, feedback: true, subagentId: 'agent-1234567890', blockedPath: '../outside/a.txt' })
    check(`${lang}: the feedback hint`, await settled(() => screen().includes(t('approval-hint-feedback'))), screen())
    check(`${lang}: the subagent and blocked-path lines`, screen().includes(t('approval-subagent', { id: 'agent-12' })) && screen().includes(t('approval-blocked-path', { path: '../outside/a.txt' })), screen())
    for (const char of 'use tmpx') await press(char)
    await press('\x7f')
    check(`${lang}: typing shows the reason on the rejection row`, await settled(() => screen().includes(t('approval-feedback-row', { label: t('approval-no'), reason: 'use tmp' }))), screen())
    await press('\r')
    check(`${lang}: Enter sends the rejection with the reason`, decisions.at(-1)?.outcome === 'rejected' && decisions.at(-1)?.decision.feedback === 'use tmp', decisions.at(-1))
    await show({ ...backend, key: `f2-${lang}`, feedback: true })
    for (const char of 'why') await press(char)
    const beforeEsc = decisions.length
    await press('\x1b')
    check(`${lang}: Esc rejects without the reason`, await settled(() => decisions.length === beforeEsc + 1) && decisions.at(-1)?.outcome === 'rejected' && decisions.at(-1)?.decision.feedback === undefined, decisions.at(-1))
  }

  // ── DSH-only lines stay ─────────────────────────────────────────
  setLang('en')
  app.rerender(React.createElement(ApprovalPanel, { key: 'bg', approval: { key: 'bg', toolName: 'Bash', agentId: 'other-session-1', external: true }, background: true, onDecide }))
  check('background and [external] lines render', await settled(() => screen().includes(t('approval-background-agent', { id: 'other-se' })) && screen().includes('[external]')), screen())
} finally {
  app.unmount()
  terminal.dispose()
}
console.log(`\nverify-approval-panel-options OK (${passed} checks)`)
process.exit(0)
