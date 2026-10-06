// Maintainer probe, not a regression test and not part of CI.
//
// The C0 verification checklist of docs/codex-backend-design.md §12.1
// (V1–V17): one minimal probe per item against a real `codex app-server`,
// conclusions recorded in docs/codex-backend-progress.md. Every run is
// pinned by scripts/lib/codex-cheap-only.mjs (throwaway CODEX_HOME, relay
// provider by `-c`, gpt-5.6-terra at effort low).
//
// Usage (one shell, so the credentials never leave it):
//   set -a; . <relay env file>; set +a
//   CODEX_EXECUTABLE=<codex 0.160.x> [CODEX_OLD_EXECUTABLE=<older codex>] \
//     node scripts/probes/codex-c0-verify.mjs <offline|live-a|live-b>…
//
//   offline  no model turn: V1 V9 V11 V16 V17 (+ V7/V8/V14 are source reads)
//   live-a   2 turns: V10 (+V2, V13) then V3 V4 V12 V15 and the resume cwd check
//   live-b   1 turn (interrupted): V5 V6
//
// Output is scrubbed: the relay base URL / host and the key never print.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { brief, connect, liveCodexHome, pinCheapOrExit, sleep, summarize, text } from './codex-probe-lib.mjs'

const { model } = pinCheapOrExit('codex-c0-verify', join(homedir(), '.dsh-tui'))
const SECRETS = [process.env.CODEX_TEST_BASE_URL, process.env.CODEX_TEST_API_KEY]
  .filter(value => typeof value === 'string' && value !== '')
try {
  const host = new URL(process.env.CODEX_TEST_BASE_URL).host
  if (host !== '') SECRETS.push(host)
} catch {
  // An unparsable base URL still has its full value in SECRETS.
}
const safe = value => {
  let out = typeof value === 'string' ? value : brief(value, 2000)
  for (const secret of SECRETS) out = out.split(secret).join('<relay>')
  return out
}
const log = (label, value) => console.log(`[${label}] ${safe(value)}`)

/** Every rollout file under a CODEX_HOME's sessions dir. */
const rollouts = home => {
  const out = []
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.jsonl')) out.push(path)
    }
  }
  walk(join(home, 'sessions'))
  return out
}

const fakeJwt = () => {
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_probe', chatgpt_plan_type: 'plus' } })}.c2lnbmF0dXJl`
}

const sections = {
  async offline() {
    // V1: stdin EOF.
    {
      const live = liveCodexHome({ model, provider: false })
      try {
        const api = await connect({ ...live })
        const t0 = Date.now()
        api.child.stdin.end()
        const exit = await Promise.race([api.exit, sleep(5000).then(() => undefined)])
        log('V1 stdin EOF', exit === undefined ? { exited: false, waitedMs: 5000 } : { exited: true, ms: Date.now() - t0, code: exit.code, signal: exit.signal })
        if (exit === undefined) await api.close()
      } finally { live.cleanup() }
    }
    // V9: config/read paths (fake values, no network).
    {
      const live = liveCodexHome({ model, provider: false, extra: 'openai_base_url = "https://example.com/v1"\nchatgpt_base_url = "https://example.com/backend-api"' })
      try {
        const api = await connect({ ...live, args: ['-c', 'model_provider="probe"', '-c', 'model_providers.probe.name="probe"', '-c', 'model_providers.probe.base_url="https://example.com/relay/v1"', '-c', 'model_providers.probe.env_key="PROBE_KEY"', '-c', 'model_providers.probe.wire_api="responses"'] })
        const read = await api.call('config/read', { includeLayers: false, cwd: live.cwd })
        const config = read.result?.config ?? {}
        log('V9 config/read keys', Object.keys(config).sort().join(','))
        log('V9 provider fields', { model_provider: config.model_provider, model_providers: config.model_providers, openai_base_url: config.openai_base_url, chatgpt_base_url: config.chatgpt_base_url, origins: Object.keys(read.result?.origins ?? {}).filter(key => /provider|base_url/u.test(key)) })
        const account = await api.call('account/read', {})
        log('V9 account/read (custom provider)', account.result ?? account.error)
        // V17 + V9 second half: external tokens on a custom provider.
        const login = await api.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: fakeJwt(), chatgptAccountId: 'acct_probe', chatgptPlanType: 'plus' })
        log('V17 login on custom provider', login.result ?? login.error)
        log('V17 account/read after (custom provider)', (await api.call('account/read', {})).result)
        await api.close()
      } finally { live.cleanup() }
    }
    // V17: chatgptAuthTokens with a syntactically valid fake JWT, first-party provider.
    {
      const live = liveCodexHome({ model, provider: false })
      try {
        const api = await connect({ ...live })
        log('V17 account/read before', (await api.call('account/read', {})).result)
        const t0 = Date.now()
        const login = await api.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: fakeJwt(), chatgptAccountId: 'acct_probe', chatgptPlanType: 'plus' })
        log('V17 login/start', { ms: Date.now() - t0, answer: login.result ?? login.error })
        await sleep(500)
        log('V17 account/read after', (await api.call('account/read', {})).result)
        log('V17 notifications', api.events.filter(event => /^account\//u.test(event.method ?? '')).map(event => ({ method: event.method, params: event.params })))
        log('V17 auth.json written', existsSync(join(live.home, 'auth.json')))
        // V11: settings update on an idle (turnless) thread.
        const started = await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' })
        const threadId = started.result?.thread?.id
        log('V11 thread/start source', { source: started.result?.thread?.source, originator: started.result?.thread?.originator, approval: started.result?.approvalPolicy })
        const mark = api.events.length
        const update = await api.call('thread/settings/update', { threadId, approvalPolicy: 'never', model: 'gpt-6-sol', effort: 'low' })
        await sleep(300)
        log('V11 thread/settings/update', update.result ?? update.error)
        log('V11 notifications', api.events.slice(mark).map(event => ({ method: event.method, params: event.params })))
        const svc = await api.call('thread/start', { cwd: live.cwd, serviceName: 'dsh-tui' })
        log('V3 thread/start with serviceName', { source: svc.result?.thread?.source, threadSource: svc.result?.thread?.threadSource })
        await api.close()
      } finally { live.cleanup() }
    }
    // V16: an older binary's handshake (no turn).
    const old = process.env.CODEX_OLD_EXECUTABLE
    if (old) {
      const live = liveCodexHome({ model, provider: false })
      try {
        const { spawnSync } = await import('node:child_process')
        log('V16 old version', spawnSync(old, ['--version'], { encoding: 'utf8' }).stdout.trim())
        const { spawn } = await import('node:child_process')
        const child = spawn(old, ['app-server'], { env: { ...process.env, CODEX_HOME: live.home }, cwd: live.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
        const lines = []
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => { lines.push(...chunk.split('\n').filter(Boolean)) })
        const send = message => child.stdin.write(JSON.stringify(message) + '\n')
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dsh-tui', title: 'dsh-TUI', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['rawResponse/completed', 'autoApprovalReview/strictReviewRequired'] } } })
        await sleep(1500)
        send({ method: 'initialized' })
        send({ id: 2, method: 'thread/start', params: { cwd: live.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' } })
        send({ id: 3, method: 'model/list', params: { includeHidden: false } })
        await sleep(1500)
        const answers = lines.map(line => { try { return JSON.parse(line) } catch { return undefined } }).filter(message => message?.id !== undefined && message.method === undefined)
        log('V16 old handshake', answers.map(message => ({ id: message.id, ok: message.error === undefined, error: message.error, keys: Object.keys(message.result ?? {}).slice(0, 8) })))
        child.kill('SIGTERM')
      } finally { live.cleanup() }
    }
  },

  async 'live-a'() {
    const live = liveCodexHome({ model })
    let api
    try {
      // V10: the relay provider arrives only through -c (no provider in config.toml).
      api = await connect({ ...live, args: live.appServerArgs, scenario: 'c0-live-a' })
      log('V10 account/read', (await api.call('account/read', {})).result)
      const read = await api.call('config/read', { includeLayers: false, cwd: live.cwd })
      log('V10 config/read provider', { model_provider: read.result?.config?.model_provider, providerIds: Object.keys(read.result?.config?.model_providers ?? {}), relayBaseUrlSet: typeof read.result?.config?.model_providers?.relay?.base_url === 'string' })
      const started = await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' })
      const threadId = started.result.thread.id
      log('V10 thread/start', { modelProvider: started.result.modelProvider, model: started.result.model, source: started.result.thread.source })
      // Turn A: V2 (the env a Codex shell exports) + V13 (fileChange add, then delete).
      const turnA = await api.call('turn/start', {
        threadId, clientUserMessageId: 'va1',
        input: text('Do exactly these three steps and nothing else. 1) Run the shell command `env | grep -E "^CODEX" | cut -d= -f1 | sort`. 2) Use apply_patch to create note.txt containing the single line: x. 3) Use apply_patch to delete note.txt. Then reply with the word done.'),
      })
      const doneA = await api.until(event => event.method === 'turn/completed' && event.params.turn.id === turnA.result?.turn?.id, 150000)
      log('V10 turn A', doneA ? doneA.params.turn.status : 'TIMEOUT')
      console.log(safe(summarize(api.events)))
      const items = (await api.call('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'full' })).result?.data?.flatMap(turn => turn.items) ?? []
      const envItem = items.find(item => item.type === 'commandExecution' && /env/u.test(item.command))
      log('V2 CODEX_* names a Codex shell exports', envItem?.aggregatedOutput ?? '(no env command item)')
      log('V13 fileChange items', items.filter(item => item.type === 'fileChange').map(item => ({ status: item.status, changes: item.changes })))

      // V4: initialTurnsPage itemsView.
      await api.call('thread/unsubscribe', { threadId })
      const resumed = await api.call('thread/resume', { threadId, excludeTurns: true, initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' } })
      const page = resumed.result?.initialTurnsPage
      log('V4 initialTurnsPage (itemsView full)', { turns: page?.data?.length, views: page?.data?.map(turn => turn.itemsView), items: page?.data?.map(turn => turn.items.map(item => item.type).join('+')), back: resumed.result?.turnsBackwardsCursor !== null })
      const defaultPage = await api.call('thread/resume', { threadId, excludeTurns: true, initialTurnsPage: { limit: 5 } })
      log('V4 initialTurnsPage (default view)', { views: defaultPage.result?.initialTurnsPage?.data?.map(turn => turn.itemsView), items: defaultPage.result?.initialTurnsPage?.data?.map(turn => turn.items.map(item => item.type).join('+')) })

      // V3: what `codex resume` lists (sourceKinds cli+vscode, the default provider filter).
      const listed = await api.call('thread/list', { limit: 20, sourceKinds: ['cli', 'vscode'], modelProviders: ['relay'] })
      log('V3 thread/list as codex resume asks', { found: listed.result?.data?.some(thread => thread.id === threadId), sources: listed.result?.data?.map(thread => thread.source) })
      const otherProvider = await api.call('thread/list', { limit: 20, sourceKinds: ['cli', 'vscode'], modelProviders: ['openai'] })
      log('V3 thread/list under another default provider', { found: otherProvider.result?.data?.some(thread => thread.id === threadId) })

      // §9.3: resume with another cwd.
      await api.call('thread/unsubscribe', { threadId })
      const elsewhere = await api.call('thread/resume', { threadId, excludeTurns: true, cwd: live.home })
      log('9.3 resume with cwd override', { cwd: elsewhere.result?.cwd === live.home ? '<override>' : elsewhere.result?.cwd === live.cwd ? '<thread cwd>' : elsewhere.result?.cwd, error: elsewhere.error })
      await api.call('thread/unsubscribe', { threadId })
      await api.call('thread/resume', { threadId, excludeTurns: true, cwd: live.cwd })

      // V15: a second app-server (the official codex stand-in) opens the same thread.
      const other = await connect({ ...live, args: live.appServerArgs, clientName: 'codex-tui-standin' })
      const conflict = await other.call('thread/resume', { threadId, excludeTurns: true })
      log('V15 second process resume', conflict.error ?? { ok: true, status: conflict.result?.thread?.status })
      if (conflict.error === undefined) {
        const turnTry = await other.call('turn/start', { threadId, clientUserMessageId: 'v15', input: text('Reply with exactly: v15') })
        log('V15 second process turn/start', turnTry.error ?? 'accepted (a turn ran)')
        if (turnTry.error === undefined) await other.until(event => event.method === 'turn/completed', 60000)
      }
      await other.close()

      // V12: an ephemeral fork with one turn: on disk? listed?
      const before = rollouts(live.home).length
      const fork = await api.call('thread/fork', { threadId, ephemeral: true, excludeTurns: true })
      const forkId = fork.result?.thread?.id
      log('V12 ephemeral fork', { ok: forkId !== undefined, ephemeral: fork.result?.thread?.ephemeral, path: fork.result?.thread?.path ?? null, error: fork.error })
      if (forkId !== undefined) {
        const turnB = await api.call('turn/start', { threadId: forkId, clientUserMessageId: 'vb1', approvalPolicy: 'never', input: text('Answer in one word: what file did you create earlier?') })
        const doneB = await api.until(event => event.method === 'turn/completed' && event.params.turn.id === turnB.result?.turn?.id, 90000)
        const answer = api.events.filter(event => event.method === 'item/completed' && event.params.threadId === forkId && event.params.item?.type === 'agentMessage').map(event => event.params.item.text).join(' ')
        log('V12 fork turn', { status: doneB?.params.turn.status, answer })
        const allThreads = await api.call('thread/list', { limit: 50, sourceKinds: [] })
        log('V12 listed / on disk', { listed: allThreads.result?.data?.some(thread => thread.id === forkId), rolloutsBefore: before, rolloutsAfter: rollouts(live.home).length })
        await api.call('thread/unsubscribe', { threadId: forkId })
      }
      // V11: settings updated on an idle thread, as a resume reports them.
      const settings = await api.call('thread/settings/update', { threadId, approvalPolicy: 'on-request', model: 'gpt-6-sol', effort: 'low' })
      await sleep(300)
      await api.call('thread/unsubscribe', { threadId })
      const after = await api.call('thread/resume', { threadId, excludeTurns: true })
      log('V11 after settings/update + resume', { update: settings.result ?? settings.error, model: after.result?.model, approvalPolicy: after.result?.approvalPolicy, effort: after.result?.reasoningEffort })
    } finally {
      if (api !== undefined) await api.close()
      live.cleanup()
    }
  },

  async 'live-b'() {
    const live = liveCodexHome({ model })
    let api
    const asked = []
    try {
      api = await connect({ ...live, args: live.appServerArgs, scenario: 'c0-live-b', onServerRequest: message => { asked.push({ id: message.id, method: message.method, itemId: message.params?.itemId }); return undefined } })
      const threadId = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' })).result.thread.id
      const turn = await api.call('turn/start', { threadId, clientUserMessageId: 'c1', input: text('Run exactly this shell command and nothing else: sleep 8 && echo slept') })
      const turnId = turn.result.turn.id
      await api.until(event => event.method === 'item/commandExecution/requestApproval', 90000)
      log('V5 first approval request', asked)
      // V5: rejoin the running thread while the approval is pending.
      const rejoin = await api.call('thread/resume', { threadId, excludeTurns: true })
      await sleep(500)
      log('V5 after resume of the running thread', { status: rejoin.result?.thread?.status ?? rejoin.error, requests: asked })
      api.respond(asked[0].id, { decision: 'accept' })
      await api.until(event => event.method === 'item/started' && event.params.item?.type === 'commandExecution' && event.params.item.status === 'inProgress' && event.at > 0, 10000)
      await sleep(800)
      // V6: steer, then interrupt before the steer can be taken.
      const steer = await api.call('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId: 's1', input: text('Also say banana.') })
      log('V6 steer answer', steer.result ?? steer.error)
      const interrupt = await api.call('turn/interrupt', { threadId, turnId })
      log('V6 interrupt answer', interrupt.result ?? interrupt.error)
      const done = await api.until(event => event.method === 'turn/completed' && event.params.turn.id === turnId, 30000)
      log('V6 turn end', done?.params.turn.status)
      await sleep(3000)
      const autoTurn = api.events.filter(event => event.method === 'turn/started' && event.params.turn.id !== turnId)
      log('V6 a turn started on its own after the interrupt', autoTurn.length)
      const turns = (await api.call('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'full' })).result?.data ?? []
      log('V6 history', turns.map(entry => ({ status: entry.status, items: entry.items.map(item => item.type === 'userMessage' ? `user(${item.clientId})` : item.type) })))
      log('V6 steer user item seen live', api.events.some(event => event.method === 'item/started' && event.params.item?.type === 'userMessage' && event.params.item.clientId === 's1'))
      console.log(safe(summarize(api.events)))
    } finally {
      if (api !== undefined) await api.close()
      live.cleanup()
    }
  },
}

const requested = process.argv.slice(2)
if (requested.length === 0 || requested.some(name => !(name in sections))) {
  console.error(`usage: node scripts/probes/codex-c0-verify.mjs <${Object.keys(sections).join('|')}>…`)
  process.exit(2)
}
for (const name of requested) {
  console.log(`=== ${name}`)
  await sections[name]()
}
