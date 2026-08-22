/**
 * WP-02 write-fence tests for the command sink (plan §1.3): write and
 * session-replacement commands capture sessionEpoch + generation before the
 * await; a completion settling after ANOTHER swap or a lifecycle resume is
 * dropped as the command's neutral shape (false / null /
 * { ok: false, reason: 'cancelled' }) and logged, so the caller commits no
 * follow-up UI for a session it no longer shows. A successful replacement's
 * OWN single epoch bump (the channel commits it in the same resolution) is
 * expected and passes the fence.
 *
 * Bare Node test runner, same harness style as
 * channel-view-model-race.test.ts: the channel is faked down to the methods
 * under test (hence the cast at the sink boundary), and the TEST performs
 * the fake channel's epoch bumps to mirror the real channel's commit order.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Channel, ResumeResult } from '../../src/dsh-adapter/channel.js'
import { createTuiCommands, type TuiFences } from '../../src/tui/commands.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Only the write commands under test exist; the sink is typed against the
 *  full Channel by design (same cast as channel-view-model-race.test.ts). */
class FakeChannel {
  sessionEpoch = 0
  newSessionResult: Promise<boolean> = Promise.resolve(false)
  resumeToResult: Promise<ResumeResult> = Promise.resolve({ ok: false, reason: 'unavailable' })
  rewindToResult: Promise<string | null> = Promise.resolve(null)
  switchModelResult: Promise<boolean> = Promise.resolve(false)
  switchPresetResult: Promise<boolean> = Promise.resolve(false)
  setEffortResult: Promise<boolean> = Promise.resolve(false)
  switchWorkspaceResult: Promise<boolean> = Promise.resolve(false)
  renameWorkspaceResult: Promise<boolean> = Promise.resolve(false)

  newSession(): Promise<boolean> {
    return this.newSessionResult
  }

  resumeTo(_id: string): Promise<ResumeResult> {
    return this.resumeToResult
  }

  rewindTo(_row: unknown, _mode?: string | null): Promise<string | null> {
    return this.rewindToResult
  }

  switchModel(_provider: string, _model: string): Promise<boolean> {
    return this.switchModelResult
  }

  switchPreset(_id: string): Promise<boolean> {
    return this.switchPresetResult
  }

  setEffort(_id: string): Promise<boolean> {
    return this.setEffortResult
  }

  switchWorkspace(_target: unknown): Promise<boolean> {
    return this.switchWorkspaceResult
  }

  renameWorkspace(_title: string): Promise<boolean> {
    return this.renameWorkspaceResult
  }
}

function makeHarness(): {
  channel: FakeChannel
  fenceState: { generation: number }
  commands: ReturnType<typeof createTuiCommands>
} {
  const channel = new FakeChannel()
  const fenceState = { generation: 0 }
  const fences: TuiFences = {
    sessionEpoch: () => channel.sessionEpoch,
    generation: () => fenceState.generation,
  }
  const commands = createTuiCommands({ channel: channel as unknown as Channel, fences })
  return { channel, fenceState, commands }
}

test('a successful session replacement passes its own fence: the single self-bump is expected', async () => {
  const { channel, commands } = makeHarness()

  const slow = deferred<ResumeResult>()
  channel.resumeToResult = slow.promise
  const pending = commands.session.resumeTo('s1')
  // The channel's own commit order: bump the epoch, then resolve { ok: true }.
  channel.sessionEpoch += 1
  slow.resolve({ ok: true })
  assert.deepEqual(await pending, { ok: true })

  // Same shape for newSession (boolean) and rewindTo (child id).
  const slowNew = deferred<boolean>()
  channel.newSessionResult = slowNew.promise
  const pendingNew = commands.session.newSession()
  channel.sessionEpoch += 1
  slowNew.resolve(true)
  assert.equal(await pendingNew, true)

  const slowRewind = deferred<string | null>()
  channel.rewindToResult = slowRewind.promise
  const pendingRewind = commands.session.rewindTo({} as never)
  channel.sessionEpoch += 1
  slowRewind.resolve('child-session-id')
  assert.equal(await pendingRewind, 'child-session-id')
})

test('a replacement completing after ANOTHER swap is dropped as its neutral shape', async () => {
  const { channel, commands } = makeHarness()

  // /resume in flight; a concurrent /new commits first (+1), then the
  // channel's own resume commit lands (+1) — the fence expected exactly one.
  const slow = deferred<ResumeResult>()
  channel.resumeToResult = slow.promise
  const pending = commands.session.resumeTo('s1')
  channel.sessionEpoch += 1
  channel.sessionEpoch += 1
  slow.resolve({ ok: true })
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' })

  // switchModel reports success but the epoch already moved under it: the
  // caller must see `false` and commit no follow-up.
  const slowModel = deferred<boolean>()
  channel.switchModelResult = slowModel.promise
  const pendingModel = commands.model.switchModel('deepseek', 'deepseek-reasoner')
  channel.sessionEpoch += 1
  channel.sessionEpoch += 1
  slowModel.resolve(true)
  assert.equal(await pendingModel, false)

  // rewindTo's neutral shape is null (same as its refused/failed returns).
  const slowRewind = deferred<string | null>()
  channel.rewindToResult = slowRewind.promise
  const pendingRewind = commands.session.rewindTo({} as never)
  channel.sessionEpoch += 1
  slowRewind.resolve(null)
  assert.equal(await pendingRewind, null)
})

test('a lifecycle resume (generation bump) drops a write completion even when the command committed', async () => {
  const { channel, fenceState, commands } = makeHarness()

  const slow = deferred<boolean>()
  channel.newSessionResult = slow.promise
  const pending = commands.session.newSession()
  // quiesce/resume (external editor) lands mid-flight; the channel commit
  // then adds its own epoch bump. Generation alone already fences it.
  fenceState.generation += 1
  channel.sessionEpoch += 1
  slow.resolve(true)
  assert.equal(await pending, false)
})

test('non-replacing writes (setEffort/switchPreset/renameWorkspace) bump nothing: any epoch move is stale', async () => {
  const { channel, commands } = makeHarness()

  // Undisturbed completions pass straight through.
  channel.setEffortResult = Promise.resolve(true)
  assert.equal(await commands.model.setEffort('high'), true)
  channel.switchPresetResult = Promise.resolve(true)
  assert.equal(await commands.model.switchPreset('liangshen'), true)
  channel.renameWorkspaceResult = Promise.resolve(true)
  assert.equal(await commands.workspace.renameWorkspace('repo'), true)

  // A session swap during the flight drops the late success: these commands
  // mutate the CURRENT session's route/preset/workspace metadata, so the
  // result is meaningless to the session the UI now shows.
  const slowEffort = deferred<boolean>()
  channel.setEffortResult = slowEffort.promise
  const pendingEffort = commands.model.setEffort('high')
  channel.sessionEpoch += 1
  slowEffort.resolve(true)
  assert.equal(await pendingEffort, false)

  const slowPreset = deferred<boolean>()
  channel.switchPresetResult = slowPreset.promise
  const pendingPreset = commands.model.switchPreset('liangshen')
  channel.sessionEpoch += 1
  slowPreset.resolve(true)
  assert.equal(await pendingPreset, false)

  const slowRename = deferred<boolean>()
  channel.renameWorkspaceResult = slowRename.promise
  const pendingRename = commands.workspace.renameWorkspace('repo')
  channel.sessionEpoch += 1
  slowRename.resolve(true)
  assert.equal(await pendingRename, false)
})

test('switchWorkspace expects the newSession self-bump on success, drops on interleave', async () => {
  const { channel, commands } = makeHarness()

  const slow = deferred<boolean>()
  channel.switchWorkspaceResult = slow.promise
  const pending = commands.workspace.switchWorkspace({} as never)
  // The delegated newSession committed: exactly one bump.
  channel.sessionEpoch += 1
  slow.resolve(true)
  assert.equal(await pending, true)

  const slowStale = deferred<boolean>()
  channel.switchWorkspaceResult = slowStale.promise
  const pendingStale = commands.workspace.switchWorkspace({} as never)
  // Another swap interleaved before this one committed.
  channel.sessionEpoch += 1
  channel.sessionEpoch += 1
  slowStale.resolve(true)
  assert.equal(await pendingStale, false)
})

test('a rejection settling after a fence move is dropped, not thrown; intact fences rethrow', async () => {
  const { channel, fenceState, commands } = makeHarness()

  const slow = deferred<boolean>()
  channel.switchModelResult = slow.promise
  const stale = commands.model.switchModel('deepseek', 'deepseek-reasoner')
  fenceState.generation += 1
  slow.reject(new Error('switch exploded'))
  // Fail closed: the caller sees the neutral shape, never the old error.
  assert.equal(await stale, false)

  const failing = deferred<boolean>()
  channel.switchModelResult = failing.promise
  const live = commands.model.switchModel('deepseek', 'deepseek-reasoner')
  failing.reject(new Error('switch exploded'))
  await assert.rejects(live, /switch exploded/)
})
