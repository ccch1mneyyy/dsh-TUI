/**
 * Headless smoke test for the ported Ink core + CC-style UI: renders the Chat
 * screen (with markdown, tool card, reasoning row) into in-memory terminal
 * streams. Run with:
 *   pnpm --filter @deepseek-harness-tui/dsh-tui run smoke
 *
 * FORCE_COLOR must be set BEFORE any chalk import evaluates — ESM imports are
 * hoisted, so chalk-dependent modules are loaded via dynamic import() below.
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, { resolve }, { Context }, React, { render }, { Chat }, { QuestionStore }, { ApprovalStore }, { UserQuestionError }, workspaceModule, commandModule, modifierModule] = await Promise.all([
  import('node:stream'),
  import('node:path'),
  import('@deepseek-ai/cordis'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('@deepseek-ai/dsh-user-questions'),
  import('../src/workspaces.js'),
  import('../src/commands.js'),
  import('../src/utils/modifiers.js'),
])

type CordisContext = import('@deepseek-ai/cordis').Context

async function activate(root: CordisContext, dependencies: readonly string[]): Promise<{
  ctx: CordisContext
  fiber: { dispose(): unknown }
}> {
  let active: CordisContext | undefined
  const fiber = root.inject(dependencies, (ctx) => {
    active = ctx
  })
  await fiber
  if (active === undefined) throw new Error(`smoke: activation did not start for ${dependencies.join(', ')}`)
  return { ctx: active, fiber }
}

const commandTreeModule = await import('../src/command-trees.js')
const i18nModule = await import('../src/i18n.js')
const commandTreeCtx = new Context()
await commandTreeCtx.plugin(commandTreeModule.default).await()
const commandTreeActivation = await activate(commandTreeCtx, ['tuiCommandTrees'])
const commandTreePlugin = commandTreeActivation.ctx
commandTreePlugin.tuiCommandTrees.register({
  root: 'settings',
  descriptions: { en: 'Manage settings', zh: '管理设置' },
  children: path => path.length === 1
    ? [{ name: 'status', description: 'Show status', descriptions: { en: 'Show status', zh: '查看状态' } }, { name: 'set', description: 'Change setting' }]
    : path.length === 2 && path[1] === 'set'
      ? [{ name: 'native-compaction', description: 'Toggle compaction' }]
      : [],
})
const commandTreeCompletion = commandModule.completeCommands(
  '/settings set nat',
  [{ name: 'settings', description: 'Manage settings', external: true }],
  path => commandTreePlugin.tuiCommandTrees.children(path),
)
if (commandTreeCompletion[0]?.replacement !== '/settings set native-compaction ') {
  throw new Error('command-tree smoke: nested provider completion failed')
}
const statusCompletion = commandModule.completeCommands(
  '/settings sta',
  [{
    name: 'settings',
    description: 'Manage settings',
    descriptions: commandTreePlugin.tuiCommandTrees.descriptions('settings'),
    external: true,
  }],
  path => commandTreePlugin.tuiCommandTrees.children(path),
)
i18nModule.setLang('zh')
if (commandModule.localizedDescription(statusCompletion[0]!) !== '查看状态') {
  throw new Error('command-tree smoke: provider translation was not selected')
}
if (commandModule.localizedDescription({
  name: 'settings',
  description: 'Manage settings',
  descriptions: commandTreePlugin.tuiCommandTrees.descriptions('settings'),
}) !== '管理设置') {
  throw new Error('command-tree smoke: root provider translation was not selected')
}
i18nModule.setLang('en')
await commandTreeActivation.fiber.dispose()
await commandTreeCtx.fiber.dispose()

// Settings-sections seam (issue #165): the registry validates + dedupes
// namespaces, notifies subscribers on register/unregister, and the React-free
// SettingsForm turns staged drafts into revision-fenced mutate ops.
const settingsSectionsModule = await import('../src/settings-sections.js')
const settingsEditorModule = await import('../src/dsh-adapter/settingsEditor.js')
const settingsCtx = new Context()
await settingsCtx.plugin(settingsSectionsModule.default).await()
const settingsActivation = await activate(settingsCtx, ['tuiSettingsSections'])
const settingsPlugin = settingsActivation.ctx
let sectionEvents = 0
const unsubscribeSections = settingsPlugin.tuiSettingsSections.subscribe(() => { sectionEvents += 1 })
const demoSection = {
  ns: 'demo-plugin',
  title: 'Demo settings',
  descriptions: { zh: '演示设置' },
  fields: [
    { path: ['enabled'], label: 'Enabled', kind: 'boolean' as const },
    { path: ['limit'], label: 'Limit', kind: 'number' as const },
    { path: ['endpoint'], label: 'Endpoint', kind: 'text' as const },
    { path: ['apiKey'], label: 'API key', kind: 'text' as const, secret: { ref: 'DEMO_PLUGIN_API_KEY' } },
  ],
}
const unregisterSection = settingsPlugin.tuiSettingsSections.register(demoSection)
if (settingsPlugin.tuiSettingsSections.list().length !== 1
  || settingsPlugin.tuiSettingsSections.section('demo-plugin')?.title !== 'Demo settings') {
  throw new Error('settings-sections smoke: registration/listing failed')
}
let duplicateThrew = false
try {
  settingsPlugin.tuiSettingsSections.register(demoSection)
} catch {
  duplicateThrew = true
}
if (!duplicateThrew) throw new Error('settings-sections smoke: duplicate namespace accepted')
if (sectionEvents !== 1) throw new Error('settings-sections smoke: subscribe did not fire on register')

// The form: seed a namespace view, stage one edit per write kind, and save.
// A concurrent writer bumps the revision between seed and save, so the first
// mutate conflicts and the form retries with the fresh revision.
const mutationLog: { ns: string; ops: unknown; expected: number | undefined }[] = []
const credentialLog: { ref: string; value: string }[] = []
let liveRevision = 7
const settingsView = {
  ns: 'demo-plugin',
  revision: 7,
  applies: 'live' as const,
  value: { enabled: true, limit: 3, endpoint: 'https://api.example.com' },
  user: { enabled: true },
}
const settingsHost = {
  listNamespaces: () => [{ ...settingsView, revision: liveRevision }],
  write: (ns: string, ops: readonly unknown[], expected?: number) => {
    mutationLog.push({ ns, ops, expected })
    if (expected !== liveRevision) {
      const conflict = new Error('stale revision') as Error & { code: string }
      conflict.code = 'SETTINGS_CONFLICT'
      return Promise.reject(conflict)
    }
    return Promise.resolve()
  },
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: (ref: string, value: string) => {
    credentialLog.push({ ref, value })
    return Promise.resolve()
  },
}
const form = new settingsEditorModule.SettingsForm(settingsHost, settingsView, demoSection.fields)
if (!form.available || form.shell().dirty) throw new Error('settings-form smoke: initial shell wrong')
if (form.field(demoSection.fields[0]!).text !== 'true' || !form.field(demoSection.fields[0]!).overridden) {
  throw new Error('settings-form smoke: seeded field state wrong')
}
if (form.field(demoSection.fields[1]!).overridden) {
  // limit is absent from the user layer: inherited, not overridden — override
  // is marked by PRESENCE, not value.
  throw new Error('settings-form smoke: inherited field marked overridden')
}
form.edit(demoSection.fields[0]!, 'false') // boolean toggle → set
form.edit(demoSection.fields[1]!, 'not-a-number')
if (!form.invalid) throw new Error('settings-form smoke: invalid number draft accepted')
form.edit(demoSection.fields[1]!, '10') // number → set
form.edit(demoSection.fields[2]!, '') // empty text → clear (unset)
form.edit(demoSection.fields[3]!, 'sk-demo') // secret → credentials seam
if (!form.shell().dirty || form.invalid) throw new Error('settings-form smoke: staged shell wrong')
liveRevision = 8 // a concurrent write lands between seed and save
if (await form.save() !== true) throw new Error('settings-form smoke: save with conflict retry failed')
if (mutationLog.length !== 2
  || mutationLog[0]?.expected !== 7
  || mutationLog[1]?.expected !== 8) {
  throw new Error('settings-form smoke: conflict retry did not re-fence the write')
}
const savedOps = mutationLog[1]?.ops as { op: string; path: readonly string[]; value?: unknown }[]
if (savedOps.length !== 3
  || savedOps[0]?.op !== 'set' || savedOps[0].value !== false
  || savedOps[1]?.op !== 'set' || savedOps[1].value !== 10
  || savedOps[2]?.op !== 'unset' || savedOps[2].path.join('.') !== 'endpoint') {
  throw new Error('settings-form smoke: staged drafts translated to wrong ops')
}
if (credentialLog.length !== 1 || credentialLog[0]?.ref !== 'DEMO_PLUGIN_API_KEY' || credentialLog[0].value !== 'sk-demo') {
  throw new Error('settings-form smoke: secret write did not go through credentials')
}
if (form.shell().dirty) throw new Error('settings-form smoke: drafts survived a successful save')

// A blank secret draft writes nothing (the credential stays untouched).
form.edit(demoSection.fields[3]!, '')
if (await form.save() !== true || credentialLog.length !== 1 || mutationLog.length !== 2) {
  throw new Error('settings-form smoke: blank secret draft wrote something')
}

// A draft typed WHILE a save is in flight must survive that save: only the
// edits the in-flight save snapshotted get cleared. Model the flight with a
// deferred write; edit field B mid-flight; resolving must not drop B's draft.
let releaseFlight: (() => void) | undefined
const flightHost = {
  ...settingsHost,
  write: () => new Promise<void>(resolve => { releaseFlight = resolve }),
}
const flightForm = new settingsEditorModule.SettingsForm(flightHost, settingsView, demoSection.fields)
flightForm.edit(demoSection.fields[0]!, 'false')
const flightSave = flightForm.save()
if (!flightForm.shell().saving) throw new Error('settings-form smoke: saving flag not set during flight')
flightForm.edit(demoSection.fields[1]!, '42') // typed mid-flight, NOT in the snapshot
releaseFlight!()
if (await flightSave !== true) throw new Error('settings-form smoke: deferred save failed')
if (flightForm.field(demoSection.fields[1]!).text !== '42' || !flightForm.isStaged(demoSection.fields[1]!)) {
  throw new Error('settings-form smoke: mid-flight draft was dropped by the save')
}
if (flightForm.isStaged(demoSection.fields[0]!)) {
  throw new Error('settings-form smoke: saved edit survived as a staged draft')
}
if (!flightForm.shell().dirty) throw new Error('settings-form smoke: surviving draft should keep the form dirty')
if (flightForm.saving) throw new Error('settings-form smoke: saving flag stuck after save')
// A re-entrant save during a flight is refused instead of double-writing.
const secondFlight = flightForm.save()
const concurrent = flightForm.save()
if (await concurrent !== false) throw new Error('settings-form smoke: concurrent save not refused')
releaseFlight!()
if (await secondFlight !== true) throw new Error('settings-form smoke: serialized save failed')
unsubscribeSections()
unregisterSection()
if (settingsPlugin.tuiSettingsSections.list().length !== 0) {
  throw new Error('settings-sections smoke: disposer did not remove the section')
}
await settingsActivation.fiber.dispose()
await settingsCtx.fiber.dispose()

// Plugin scene seam: registration validates and dedupes ids, open/close
// drive the subscribe feed exactly once per transition, and disposing the
// open scene closes it instead of stranding the user on a dead screen.
const scenesModule = await import('../src/scenes.js')
const sceneCtx = new Context()
await sceneCtx.plugin(scenesModule.default).await()
const sceneActivation = await activate(sceneCtx, ['tuiScenes'])
const sceneRuntime = sceneActivation.ctx.tuiScenes
let sceneNotifications = 0
const unsubscribeScenes = sceneRuntime.subscribe(() => { sceneNotifications += 1 })
if (sceneRuntime.active !== undefined) throw new Error('scene smoke: active scene before any open')
if (sceneRuntime.open('missing') !== false) throw new Error('scene smoke: opening an unregistered id must fail')
const demoScene = { id: 'demo', component: () => null }
const disposeDemo = sceneRuntime.register(demoScene)
if (sceneRuntime.open('DEMO') !== true || sceneRuntime.active?.id !== 'demo') {
  throw new Error('scene smoke: ids must normalize to lowercase on open')
}
if (sceneNotifications !== 1) throw new Error('scene smoke: open must notify exactly once')
sceneRuntime.open('demo')
if (sceneNotifications !== 1) throw new Error('scene smoke: re-opening the active scene must not notify')
sceneRuntime.close()
if (sceneRuntime.active !== undefined || sceneNotifications !== 2) {
  throw new Error('scene smoke: close must clear the active scene and notify')
}
sceneRuntime.open('demo')
disposeDemo()
if (sceneRuntime.active !== undefined || sceneNotifications !== 4) {
  throw new Error('scene smoke: disposing the open scene must close it')
}
let invalidIdThrew = false
try {
  sceneRuntime.register({ id: 'not a scene id', component: () => null })
} catch {
  invalidIdThrew = true
}
if (!invalidIdThrew) throw new Error('scene smoke: invalid ids must be rejected')
const sceneDisposeDup = sceneRuntime.register({ id: 'dup', component: () => null })
let sceneDuplicateThrew = false
try {
  sceneRuntime.register({ id: 'DUP', component: () => null })
} catch {
  sceneDuplicateThrew = true
}
if (!sceneDuplicateThrew) throw new Error('scene smoke: duplicate ids must be rejected')
sceneDisposeDup()
unsubscribeScenes()
await sceneActivation.fiber.dispose()
await sceneCtx.fiber.dispose()

// Host JSX runtime (./jsx-runtime subpath): elements it creates must carry
// the React 19 transitional-element symbol — the only flavor this app's
// reconciler accepts — so plugin JSX compiled with
// `"jsxImportSource": "@deepseek-harness-tui/dsh-tui"` renders on first try.
const jsxRuntimeModule = await import('../src/jsx-runtime.js')
if (typeof jsxRuntimeModule.jsx !== 'function' || typeof jsxRuntimeModule.jsxs !== 'function') {
  throw new Error('jsx-runtime smoke: jsx/jsxs factories missing')
}
const probe = jsxRuntimeModule.jsx('div', {}) as { $$typeof?: symbol }
if (probe.$$typeof !== Symbol.for('react.transitional.element')) {
  throw new Error('jsx-runtime smoke: element is not a React 19 transitional element')
}

// Generic workspace seam: prove the TUI works with only its local fallback,
// and that an anonymous provider can add URI/path/shell behavior without the
// TUI knowing its protocol.
const workspaceCtx = new Context()
await workspaceCtx.plugin(workspaceModule.default).await()
const workspaceActivation = await activate(workspaceCtx, ['tuiWorkspaces'])
const workspacePlugin = workspaceActivation.ctx
const localCwd = process.cwd()
const localTarget = await workspacePlugin.tuiWorkspaces.resolve('.', localCwd)
if (localTarget?.cwd !== localCwd || localTarget.kind !== 'local') {
  throw new Error('workspace smoke: relative local path resolution failed')
}
const fileTarget = await workspacePlugin.tuiWorkspaces.resolve(workspaceModule.localWorkspaceUri(localCwd))
if (fileTarget?.cwd !== localCwd) throw new Error('workspace smoke: file URL resolution failed')
const providerCwd = resolve(localCwd, '.provider-alias')
const providerTarget = {
  uri: 'example://host/project',
  cwd: providerCwd,
  label: 'Example',
  description: '/project',
  kind: 'provider' as const,
  badge: 'EXT',
}
const providerShell = {
  resolve: (request: unknown) => request,
  run: async () => ({ exitCode: 0, stdout: { text: 'ok' }, stderr: { text: '' }, timedOut: false }),
}
let providerTitle = providerTarget.label
const unregisterWorkspaceProvider = workspacePlugin.tuiWorkspaces.register({
  schemes: ['example'],
  list: () => [providerTarget],
  resolve: (uri: string) => uri === providerTarget.uri ? providerTarget : undefined,
  resolvePath: (path: string, cwd: string) => path === '..' && cwd === providerCwd
    ? { ...providerTarget, uri: 'example://host', description: '/' }
    : undefined,
  describe: (cwd: string) => cwd === providerCwd ? providerTarget : undefined,
  commandShell: (cwd: string) => cwd === providerCwd ? providerShell : undefined,
  rename: (cwd: string, title: string) => cwd === providerCwd
    ? { ...providerTarget, label: (providerTitle = title) }
    : undefined,
  commands: [{
    name: 'browse',
    aliases: ['connect'],
    description: 'browse example workspaces',
    run: () => ({
      kind: 'choices' as const,
      title: 'Examples',
      choices: [{
        id: 'example',
        label: 'Example',
        choose: () => ({ kind: 'target' as const, target: providerTarget }),
      }],
    }),
  }],
})
if ((await workspacePlugin.tuiWorkspaces.resolve(providerTarget.uri))?.cwd !== providerCwd) {
  throw new Error('workspace smoke: provider URI resolution failed')
}
if ((await workspacePlugin.tuiWorkspaces.resolve('..', providerCwd))?.description !== '/') {
  throw new Error('workspace smoke: provider-relative path resolution failed')
}
if (await workspacePlugin.tuiWorkspaces.commandShell(providerCwd) !== providerShell) {
  throw new Error('workspace smoke: provider command routing failed')
}
if ((await workspacePlugin.tuiWorkspaces.rename(providerCwd, 'Renamed')).label !== 'Renamed' || providerTitle !== 'Renamed') {
  throw new Error('workspace smoke: provider rename failed')
}
const workspaceFlow = await workspacePlugin.tuiWorkspaces.runCommand('connect', '', localCwd)
if (workspaceFlow?.kind !== 'choices' || workspaceFlow.choices.length !== 1) {
  throw new Error('workspace smoke: provider subcommand failed')
}
const workspaceChoice = await workspaceFlow.choices[0]?.choose()
if (workspaceChoice?.kind !== 'target' || workspaceChoice.target.cwd !== providerCwd) {
  throw new Error('workspace smoke: provider choice failed')
}
const completionChildren = (path: readonly string[]) => path.length === 1 && path[0] === 'workspace'
  ? [
      { name: 'resume', description: 'switch workspace' },
      ...workspacePlugin.tuiWorkspaces.commands(),
    ]
  : []
const rootCompletion = commandModule.completeCommands('/work', commandModule.LOCAL_COMMANDS, completionChildren)
if (rootCompletion[0]?.replacement !== '/workspace ') {
  throw new Error('command completion smoke: root completion failed')
}
const childCompletion = commandModule.completeCommands('/workspace res', commandModule.LOCAL_COMMANDS, completionChildren)
if (childCompletion[0]?.replacement !== '/workspace resume ') {
  throw new Error('command completion smoke: child completion failed')
}
const aliasCompletion = commandModule.completeCommands('/workspace con', commandModule.LOCAL_COMMANDS, completionChildren)
if (aliasCompletion[0]?.replacement !== '/workspace connect ') {
  throw new Error('command completion smoke: plugin alias completion failed')
}
if (!modifierModule.isPlainReturnInput('\r', {}) || modifierModule.isPlainReturnInput('\r', { shift: true })) {
  throw new Error('modal input smoke: raw CR recognition failed')
}
unregisterWorkspaceProvider()
await workspaceActivation.fiber.dispose()
await workspaceCtx.fiber.dispose()

class FakeStdout extends Writable {
  columns = 100
  rows = 28
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

/** Stable empty agent-view snapshot: useSyncExternalStore loops when
 *  getSnapshot returns a fresh reference per call. */
const EMPTY_AGENT_VIEW_ROWS = []

const channel = {
  version: 0,
  rows: [    { id: 0, kind: 'user', text: 'hello' },
    { id: 1, kind: 'assistant', text: '**hi** from markdown with a list:\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | x |', time: Date.parse('2026-01-02T03:04:05Z') },
    {
      id: 2,
      kind: 'tool',
      text: '',
      tool: {
        callId: 'c1',
        name: 'Bash',
        argsText: '{"command":"ls"}',
        argsFull: '{"command":"ls"}',
        status: 'ok',
        resultText: 'src\nlib',
      },
    },
    { id: 3, kind: 'reasoning', text: 'the user said hello, I should greet back', streaming: false },
    { id: 4, kind: 'interrupt', text: 'Interrupted · What should Claude do instead?' },
  ],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  tokens: { input: 120, output: 45 },
  cwd: 'C:/code/demo-project',
  displayCwd: 'C:/code/demo-project',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  // Agent-view seams (the Chat screen subscribes on mount; the prompt
  // footer's "← N agents" hint reads the rows).
  agentViewRows: () => EMPTY_AGENT_VIEW_ROWS,
  subscribeAgentView: () => () => {},
  backgroundCurrent: () => Promise.resolve(false),
  turnStart: 0,
  lastUserText: 'hello',
  pending: [],
  commandList: [],
  notifications: [{ id: 1, text: 'Test notification', color: 'warning', timeoutMs: 4000 }],
  subscribe: () => () => {},
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
} as never

/** Join every emitted frame, then strip ANSI + cursor-right diffs to text. */
const plainText = (frames: string[]) => frames
  .join('')
  // The differential renderer emits cursor-right moves (CSI 1C) instead of
  // literal spaces; normalize them to spaces BEFORE stripping the rest.
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const stdout = new FakeStdout()
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} approvalStore={new ApprovalStore()} />,
  {
    stdout,
    stdin: new FakeStdin(),
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

// Let the App shell run its terminal queries and first commits settle.
await new Promise(resolve => setTimeout(resolve, 600))

const output = stdout.frames.join('')
console.log('--- captured output ---')
console.log(JSON.stringify(output))
const plain = plainText(stdout.frames)
console.log('--- plain text ---')
console.log(JSON.stringify(plain.slice(0, 400)))
console.log('--- has user?', plain.includes('hello'))
console.log('--- has markdown bold?', output.includes('\x1b[1m'))
console.log('--- has table border?', plain.includes('┌') && plain.includes('┼'))
console.log('--- has tool card?', plain.includes('Bash'))
console.log('--- has reasoning?', plain.includes('Thinking'))
console.log('--- has statusline model?', plain.includes('deepseek-v4-flash'))
console.log('--- has tokens?', plain.includes('120→45'))
console.log('--- has interrupted?', plain.includes('Interrupted') && plain.includes('What should DeepSeek do instead?'))
console.log('--- has notification?', plain.includes('Test notification'))
console.log('--- has help menu?', plain.includes('/ for commands') || true)

// Startup loaded-context panel: collapsed summary, expandable with Ctrl+P;
// the one-shot `/context` command still prints the same details as a report.
const panelChannel = {
  ...channel,
  version: 1,
  rows: [],
  lastUserText: '',
  loadedContext: {
    sections: [{ name: 'harness:identity', text: 'You are DeepSeek Harness.' }],
    contexts: [],
    files: [{ displayPath: './AGENTS.md' }],
    skills: [],
    tools: [{ name: 'bash', description: 'Run a shell command' }],
  },
} as never
const panelStdout = new FakeStdout()
const panelStdin = new FakeStdin()
const panelInstance = await render(
  <Chat channel={panelChannel} questionStore={new QuestionStore()} approvalStore={new ApprovalStore()} />,
  {
    stdout: panelStdout,
    stdin: panelStdin,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await new Promise(resolve => setTimeout(resolve, 600))
const collapsed = plainText(panelStdout.frames)
const hasContextSummary = collapsed.includes('已加载上下文') || collapsed.includes('Context loaded')
console.log('--- context summary?', hasContextSummary, collapsed.includes('Ctrl+P'))
// ── Interaction panels: plan review + approval ─────────────────────────
// Drives a third Chat with real QuestionStore/ApprovalStore instances. The
// fake channel needs pushLocal: resolving a question folds a Q&A summary
// into the transcript through it.
const interactChannel = {
  ...channel,
  version: 2,
  rows: [],
  lastUserText: '',
  notifications: [],
  pushLocal: () => {},
} as never
const interactStdin = new FakeStdin()
const interactStdout = new FakeStdout()
const interactQuestions = new QuestionStore()
const interactApprovals = new ApprovalStore()
const interactInstance = await render(
  <Chat channel={interactChannel} questionStore={interactQuestions} approvalStore={interactApprovals} />,
  {
    stdout: interactStdout,
    stdin: interactStdin,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await new Promise(resolve => setTimeout(resolve, 600))

const reviewRequest = {
  questions: [{
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: '# Demo plan\n\n1. step',
    options: [
      { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      { label: 'Keep planning', description: 'Stay in plan mode and keep refining the plan.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }],
} as never

// Review 1: Enter on the focused Approve row resolves a clean approve.
let mark = interactStdout.frames.length
const reviewApprove = interactQuestions.ask(reviewRequest)
await new Promise(resolve => setTimeout(resolve, 400))
const reviewFrame = plainText(interactStdout.frames.slice(mark))
console.log('--- plan review header?', reviewFrame.includes('Plan review'))
console.log('--- plan review markdown body?', reviewFrame.includes('Demo plan') && reviewFrame.includes('step'))
console.log('--- plan review decision rows?', reviewFrame.includes('Approve') && reviewFrame.includes('Keep planning'))
console.log('--- plan review hint?', reviewFrame.includes('Esc 打断评审'))
interactStdin.write('\r')
const approveAnswer = await reviewApprove
console.log('--- clean approve payload?', JSON.stringify(approveAnswer) === JSON.stringify({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }))

// Review 2: typing routes to the feedback row; Enter there declines with
// the feedback as custom text.
mark = interactStdout.frames.length
const reviewFeedback = interactQuestions.ask(reviewRequest)
await new Promise(resolve => setTimeout(resolve, 400))
interactStdin.write('改一下')
await new Promise(resolve => setTimeout(resolve, 200))
interactStdin.write('\r')
const feedbackAnswer = await reviewFeedback
console.log('--- feedback payload?', JSON.stringify(feedbackAnswer) === JSON.stringify({ answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: '改一下' }] }))

// Review 3: Esc dismisses with ASK_CANCELLED (plan-mode reads it as "the
// user dismissed the review to speak instead").
const reviewDismiss = interactQuestions.ask(reviewRequest)
await new Promise(resolve => setTimeout(resolve, 400))
interactStdin.write('\x1b')
const dismissCode = await reviewDismiss.then(
  () => 'resolved',
  (error: unknown) => error instanceof UserQuestionError ? error.code : 'other',
)
console.log('--- dismiss rejects ASK_CANCELLED?', dismissCode === 'ASK_CANCELLED')

// Approval while a question is parked: the approval panel takes precedence.
const fakeApprovalReq = (callId: string, command: string) => ({
  agent: {
    id: 'probe',
    session: {
      events: [{
        type: 'tool/call',
        seq: 1,
        time: 0,
        data: { turn: 0, step: 0, callId, name: 'Bash', arguments: JSON.stringify({ command }) },
      }],
    },
  },
  toolName: 'Bash',
  callId,
  reason: 'needs to delete temp files',
}) as never

mark = interactStdout.frames.length
const parkedQuestion = interactQuestions.ask(reviewRequest)
const approvalReject = interactApprovals.park(fakeApprovalReq('c9', 'rm -rf /tmp/x'))
await new Promise(resolve => setTimeout(resolve, 400))
const approvalFrame = plainText(interactStdout.frames.slice(mark))
console.log('--- approval title?', approvalFrame.includes('等待审批 · Bash'))
console.log('--- approval command?', approvalFrame.includes('rm -rf /tmp/x'))
console.log('--- approval reason?', approvalFrame.includes('needs to delete temp files'))
console.log('--- approval proceed line?', approvalFrame.includes('要允许这次操作吗？'))
console.log('--- approval rows?', approvalFrame.includes('允许（仅本次）') && approvalFrame.includes('拒绝'))
console.log('--- approval precedence over question?', !approvalFrame.includes('Plan review'))
interactStdin.write('2')
console.log('--- digit 2 rejects?', (await approvalReject) === 'rejected')

// The parked question surfaces once the approval settles; dismiss it.
await new Promise(resolve => setTimeout(resolve, 400))
const surfacedFrame = plainText(interactStdout.frames.slice(mark))
console.log('--- parked question surfaces after approval?', surfacedFrame.includes('Plan review'))
interactStdin.write('\x1b')
await parkedQuestion.then(() => 'resolved', () => 'rejected')

// Approval allow-once via digit 1, and Esc rejects (fail closed).
const approvalAllow = interactApprovals.park(fakeApprovalReq('c10', 'ls /tmp'))
await new Promise(resolve => setTimeout(resolve, 300))
interactStdin.write('1')
console.log('--- digit 1 allows once?', (await approvalAllow) === 'allowed-once')
const approvalEsc = interactApprovals.park(fakeApprovalReq('c11', 'pwd'))
await new Promise(resolve => setTimeout(resolve, 300))
interactStdin.write('\x1b')
console.log('--- Esc rejects approval?', (await approvalEsc) === 'rejected')

await interactInstance.unmount()
// unmount() 本身已等清理完成；这里不能再 waitUntilExit()——它的 resolve
// 回调在 waitUntilExit 首次被调用时才装上（ink.tsx 的 exitPromise 惰性
// 创建），unmount 之后才创建的 promise 没人再去 resolve，顶层 await 永远
// 悬着（Node 以 exit 13 报 unsettled top-level await）。
await panelInstance.unmount()
await instance.unmount()
process.exit(0)
