/**
 * LIVE headless Chat on the Claude backend — real `claude` CLI, real (small)
 * usage. NOT part of CI: runs only with DSH_TUI_CLAUDE_LIVE=1, prints SKIP
 * otherwise. HAIKU ONLY (maintainer cost rule, 2026-10-02): the model is
 * pinned and the run refuses to start on any other
 * (scripts/lib/claude-haiku-only.mjs). Mounts the real `Chat` (headless renderer, like scripts/smoke.tsx)
 * over a channel bound to a Claude Agent session (haiku), submits a prompt
 * through the prompt input and waits until the assistant's reply renders;
 * also checks that DSH-only commands are hidden and refused, and (Phase 4a,
 * the channel core serves every backend) that the IDE selection channel
 * (an in-process IDE fixture), the git-branch breadcrumb and `/export` work
 * on the Claude session — within the same single turn.
 *
 * Run: DSH_TUI_CLAUDE_LIVE=1 node --import tsx/esm scripts/verify-claude-headless.tsx
 */
process.env.FORCE_COLOR = '3'

if (process.env.DSH_TUI_CLAUDE_LIVE !== '1') {
  console.log('SKIP verify-claude-headless (set DSH_TUI_CLAUDE_LIVE=1 to run against the real Claude CLI)')
  process.exit(0)
}

const { pinHaikuOrExit } = await import('./lib/claude-haiku-only.mjs')
pinHaikuOrExit('verify-claude-headless', (await import('../src/utils/paths.js')).DATA_DIR)

const [{ execFile, execFileSync }, { startWsFixture }] = await Promise.all([import('node:child_process'), import('./lib/ide-ws-fixture.js')])

const [{ Writable, PassThrough }, { mkdtempSync, readFileSync, rmSync, writeFileSync }, { tmpdir }, { join }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { claudeBackend }, { setLang, t }, { default: instances }, { settled, sleep, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/dsh-adapter/approvals.js'),
    import('../src/dsh-adapter/channel.js'),
    import('../src/backends/claude/index.js'),
    import('../src/i18n.js'),
    import('../src/ink/instances.js'),
    import('./lib/term-test.mjs'),
  ])

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) throw new Error(`${label}${detail ? `\n${detail}` : ''}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-headless-'))
writeFileSync(join(root, 'README.md'), '# headless fixture\n')
// A real git repository on a known branch (the status-line breadcrumb).
execFileSync('git', ['init', '-q', '-b', 'headless-branch'], { cwd: root })
// A minimal host shell service (the channel core runs `git branch` and
// `!cmd` through `ctx.get('shell')`).
const shell = {
  resolve: (request: unknown) => request,
  run: (spec: { command: string; workdir: string; timeoutMs: number }) => new Promise(resolve => {
    execFile('sh', ['-c', spec.command], { cwd: spec.workdir, timeout: spec.timeoutMs }, (error, stdout, stderr) => {
      resolve({ stdout: { text: String(stdout) }, stderr: { text: String(stderr) }, timedOut: error?.killed === true })
    })
  }),
}
// An in-process IDE that pushes a selection once the channel connects.
const ide = await startWsFixture('tok-headless', [root], { clearSelectionAfterMs: null })
process.env.DSH_TUI_IDE_PORT = String(ide.port)
process.env.DSH_TUI_IDE_TOKEN = 'tok-headless'
const host = { cwd: root, debug: () => undefined, warn: () => undefined, stderr: () => undefined }
const session = await claudeBackend.open({ kind: 'create', cwd: root }, host)
const ctx = {
  on: () => () => undefined,
  get: (name: string) => name === 'shell' ? shell : undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
} as never
const channel = createChannel(ctx, session, {
  model: claudeBackend.descriptor.label,
  provider: claudeBackend.id,
  cwd: root,
  activity: false,
  backendLabel: claudeBackend.descriptor.label,
})

// The IDE dial has a short connect budget: let it land before the first
// (heavy) Chat render occupies the event loop.
const ideLinked = await settled(() => channel.selection !== undefined, { timeoutMs: 10_000 })

const COLS = 110
const ROWS = 34
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const screen = (): string => viewportLines(term, ROWS).join('\n')
const instance = await ui.render(
  React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore(),
    approvalStore: new ApprovalStore(),
    onExit: () => undefined,
    fullscreen: false,
    trajectorySeen: true,
  }),
  { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)
const type = async (text: string): Promise<void> => {
  for (const char of text) stdin.write(char)
  // 固定窗:pacing the prompt applies typed characters on its own render tick.
  await sleep(80)
}
const clear = async (): Promise<void> => {
  for (let i = 0; i < 32; i += 1) stdin.write('\x7f')
  // 固定窗:pacing backspaces land before the next keystroke batch.
  await sleep(80)
}

try {
  // 固定窗:pacing the key handlers attach after the first frame.
  await sleep(400)
  check('DSH-only commands are not offered', !channel.commandList.some(command => ['preset', 'tree', 'rewind', 'balance'].includes(command.name)))
  // Phase 3: the backend's own controls are served.
  check('Claude controls are offered', ['model', 'effort', 'compact', 'context', 'mcp', 'login'].every(name => channel.commandList.some(command => command.name === name)), channel.commandList.map(command => command.name).join(' '))
  await type('/preset')
  stdin.write('\r')
  const refusal = t('cmd-unavailable-backend', { cmd: 'preset', backend: claudeBackend.descriptor.label })
  check('a typed DSH-only command is refused, not sent', await settled(() => channel.notifications.some(item => item.text === refusal)), channel.notifications.map(item => item.text).join(' | '))
  await clear()

  check('the IDE selection reaches the Claude session\'s channel', ideLinked)
  check('the git branch breadcrumb shows on the Claude session', await settled(() => channel.gitBranch === 'headless-branch', { timeoutMs: 10_000 }), String(channel.gitBranch))
  await type('Reply with exactly: headless-ok')
  stdin.write('\r')
  const rendered = await settled(
    () => channel.rows.some(row => row.kind === 'assistant' && row.streaming !== true && row.text.includes('headless-ok')) && screen().includes('headless-ok') && !channel.working,
    { timeoutMs: 120_000 },
  )
  check('the assistant reply renders in the transcript', rendered, screen())
  check('the confirmed user bubble renders', channel.rows.some(row => row.kind === 'user' && row.text === 'Reply with exactly: headless-ok'))
  check('the status line shows the Claude model', /haiku/iu.test(channel.model), channel.model)
  check('the backend reports its session cost', channel.costReport?.currency === 'USD')
  check('the submitted message carried the IDE selection (indicator on the user row)', channel.rows.some(row => row.kind === 'user' && row.selectionAttached !== undefined))
  const exported = channel.exportSession()
  check('/export writes the Claude transcript', exported !== null && readFileSync(exported, 'utf8').includes('headless-ok'), String(exported))
} finally {
  instance.unmount()
  channel.releaseContributions()
  await session.dispose()
  ide.close()
  delete process.env.DSH_TUI_IDE_PORT
  delete process.env.DSH_TUI_IDE_TOKEN
  term.dispose()
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nverify-claude-headless OK (${passed} checks)`)
process.exit(0)
