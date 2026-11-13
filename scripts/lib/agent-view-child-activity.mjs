import { setImmediate as drain } from 'node:timers/promises'
import { createAgentViewProjection } from '../../src/dsh-adapter/channel/agent-view-projection.js'
import { createChannelOwner } from '../../src/dsh-adapter/channel/owner.js'
import { ApprovalStore } from '../../src/dsh-adapter/approvals.js'
import { QuestionStore } from '../../src/dsh-adapter/questions.js'
import { settled } from './term-test.mjs'

/** Exercise cache invalidation with real stores, including hidden queued asks. */
export async function verifyChildActivity(check) {
  const owner = createChannelOwner()
  const makeAgent = (id, parentSession) => ({ id, status: 'idle', session: {
    id, header: { id, cwd: '/work/repo', createdAt: 1, ...(parentSession === undefined ? {} : { parentSession, origin: 'subagent' }) },
    events: parentSession === undefined ? [{ type: 'user/message', time: 1, data: { content: 'delegate it' } }, { type: 'turn/end', time: 2, data: { reason: { kind: 'completed' } } }] : [],
  } })
  const parent = makeAgent('parent')
  const child = makeAgent('child', 'parent')
  const other = makeAgent('other')
  let liveRoster = [parent, child]
  const events = new Map()
  const approvals = new ApprovalStore()
  const questions = new QuestionStore()
  const promises = []
  let rosterReads = 0
  const view = createAgentViewProjection({
    get: name => name === 'agents' ? { list() { rosterReads += 1; return liveRoster } } : undefined,
    on(name, callback) { events.set(name, callback); return () => events.delete(name) },
  }, { owner, binding: { agent: parent }, cwd: () => '/work/repo', provider: 'deepseek', model: 'test-model', notify() {},
    listPersisted: async () => [], createDetached: async () => { throw Error('unused') }, sessionSwitchVetoed: async () => false,
    adoptLive: async () => { throw Error('unused') }, resumeInto: async () => { throw Error('unused') },
  })
  view.bindApprovalStore(approvals)
  view.bindQuestionStore(questions)
  view.start()
  await drain()
  const status = () => view.rows().find(row => row.id === 'parent')?.status
  const ask = (agentId, signal) => {
    promises.push(questions.ask({ agentId, signal, questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'yes' }] }] }).catch(() => undefined))
  }
  const park = (agent, signal) => { promises.push(approvals.park({ agent, toolName: 'exec', signal })) }
  try {
    check('stores: settled parent starts completed', status() === 'completed')
    const cached = view.rows()
    const reads = rosterReads
    check('stores: repeated reads reuse the row snapshot without scanning the roster', view.rows() === cached && rosterReads === reads)

    child.status = 'running'
    events.get('agent/status')()
    check('events: child status changes invalidate the parent through the existing scheduler', await settled(() => status() === 'working'))
    liveRoster = [parent]
    events.get('agent/disposed')({ agent: child })
    check('events: disposing the running child restores completion', status() === 'completed')
    liveRoster = [parent, child]
    events.get('agent/created')()
    check('events: creating a running child restores working', status() === 'working')
    child.status = 'idle'
    events.get('agent/status')()
    check('events: child settling restores completion through the existing scheduler', await settled(() => status() === 'completed'))

    ask('child')
    await drain()
    check('stores: an active child question keeps the parent working', status() === 'working')
    questions.answerCurrent({ selected: ['yes'] })
    await drain()
    check('stores: answering the child restores completion', status() === 'completed')

    ask('other')
    const panel = questions.getSnapshot()
    check('stores: an unrelated question leaves the parent completed', status() === 'completed')
    const queuedQuestion = new AbortController()
    ask('child', queuedQuestion.signal)
    await drain()
    check('stores: a queued child question invalidates the parent row', status() === 'working')
    check('stores: adding a queued question retains the active panel snapshot', questions.getSnapshot() === panel)
    // Establish the active row independently, so this assertion also detects
    // missing removal notifications when the addition check already failed.
    view.notify()
    check('stores: pending queued questions participate in derivation', status() === 'working')
    queuedQuestion.abort()
    await drain()
    check('stores: aborting a queued child question restores completion', status() === 'completed')
    questions.rejectAll()
    await drain()

    ask('parent')
    await drain()
    check('stores: the parent own question is needs-input, not completed', status() === 'needs-input')
    questions.answerCurrent({ selected: ['yes'] })
    await drain()

    park(other)
    const approvalPanel = approvals.getSnapshot()
    check('stores: an unrelated approval leaves the parent completed', status() === 'completed')
    const queuedApproval = new AbortController()
    park(child, queuedApproval.signal)
    await drain()
    check('stores: a queued child approval invalidates the parent row', status() === 'working')
    check('stores: adding a queued approval retains the active panel snapshot', approvals.getSnapshot() === approvalPanel)
    view.notify()
    check('stores: pending queued approvals participate in derivation', status() === 'working')
    queuedApproval.abort()
    await drain()
    check('stores: aborting a queued child approval restores completion', status() === 'completed')
    approvals.settleAll('cancelled')
    await drain()
    const activeApproval = new AbortController()
    park(child, activeApproval.signal)
    await drain()
    check('stores: an active child approval keeps the parent working', status() === 'working')
    activeApproval.abort()
    await drain()
    check('stores: aborting the last active approval restores completion', status() === 'completed')

    let notifications = 0
    view.subscribe(() => { notifications += 1 })
    owner.dispose()
    const disposedAt = notifications
    ask('child')
    park(child)
    await drain()
    check('stores: owner teardown revokes roster and store subscriptions', events.size === 0 && notifications === disposedAt)
  } finally {
    owner.dispose()
    questions.rejectAll()
    approvals.settleAll('cancelled')
    await Promise.all(promises)
  }
}
