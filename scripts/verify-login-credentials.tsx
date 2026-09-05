/**
 * Headless regression for /login credential status. The fake channel exposes
 * metadata only: no credential value enters the UI or this test.
 */
process.env.FORCE_COLOR = '0'
delete process.env.DEEPSEEK_API_KEY

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { render },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS },
  { setLang },
  { settled, sleep },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])

class FakeStdout extends Writable {
  columns = 100
  rows = 28
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
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
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const SECRET_SENTINEL = 'test-secret-must-not-appear'

function makeChannel(status: unknown) {
  return {
    version: 0,
    whaleIdle: false, // 探针确定性：鲸鱼闲置动画不进测量窗口
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'login-probe',
    agentId: 'login-probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting' as const,
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    commandList: LOCAL_COMMANDS,
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: 'high',
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    workingActivity: undefined,
    activityFrames: 'claude',
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    loadedContext: undefined,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe: () => () => {},
    localCalls: [] as { command: string; lines: readonly string[] }[],
    credentialRefs: [] as string[],
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    notify() {},
    pushLocal(command: string, lines: readonly string[]) {
      this.localCalls.push({ command, lines })
    },
    async describeCredential(ref: string) {
      this.credentialRefs.push(ref)
      if (status instanceof Error) throw status
      return status
    },
    listModels: () => Promise.resolve([]),
    // No dsh-auth-style plugin in this harness: /login renders exactly its
    // pre-plugin lines (the OAuth account section stays absent).
    oauthProviderStatuses: async () => undefined,
    commandCompletions(input: string) {
      const prefix = input.replace(/^\//u, '').trim().toLowerCase()
      return this.commandList
        .filter(command => command.name.startsWith(prefix))
        .map(command => ({ ...command, commandLine: `/${command.name}`, replacement: `/${command.name} ` }))
    },
    runExternalCommand: async () => '',
    loadOlder: () => 0,
    listFiles: async () => [],
    listSessions: () => [],
    previewSession: async () => [],
    setResumeTarget: () => {},
    setActivityFrames: () => true,
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    listSubagents: async () => [],
    compact() {},
  }
}

async function runLogin(status: unknown) {
  const channel = makeChannel(status)
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} />,
    {
      stdout: new FakeStdout(),
      stdin,
      stderr: new FakeStderr(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  // 启动等待保留固定 sleep：假 stdout 丢弃全部帧，没有可轮询的观察点。
  await sleep(500)
  stdin.write('/login\r')
  const reported = await settled(() => channel.localCalls.length === 1)
  await instance.unmount()
  assert.ok(reported, '/login must produce one local report')
  // 卸载后再精确计数：迟到的第二条 report 只有在这里才会被发现。
  assert.equal(channel.localCalls.length, 1, '/login must produce exactly one local report (post-unmount)')
  assert.deepEqual(channel.credentialRefs, ['DEEPSEEK_API_KEY'], '/login must query the credentials service')
  return channel.localCalls[0].lines
}

setLang('en')

const configured = await runLogin({
  configured: true,
  source: 'file',
  writable: true,
  value: SECRET_SENTINEL,
})
assert.ok(configured.some(line => line.includes('configured')), 'managed credential must be shown as configured')
assert.ok(configured.some(line => line.includes('file')), 'credential source must be shown')
assert.ok(configured.some(line => line.includes('writable')), 'credential writability must be shown')
assert.ok(configured.every(line => !line.includes('not configured')), 'managed credential must not be reported missing')

const missing = await runLogin({ configured: false, writable: true })
assert.ok(missing.some(line => line.includes('not configured')), 'missing credential must be reported')
assert.ok(missing.some(line => line.includes('none')), 'missing credential must have no source')

const unavailable = await runLogin(undefined)
assert.ok(unavailable.some(line => line.includes('service unavailable')), 'missing service must degrade clearly')

const rejected = await runLogin(new Error('credential backend unavailable'))
assert.ok(rejected.some(line => line.includes('service unavailable')), 'describe failure must degrade safely')

for (const lines of [configured, missing, unavailable, rejected]) {
  assert.ok(
    lines.every(line => !line.includes(SECRET_SENTINEL)),
    'credential values must never enter /login output',
  )
}

console.log('/login credential status verified (configured, missing, unavailable, rejected)')
