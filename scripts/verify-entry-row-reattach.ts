/**
 * Regression for #1651: a `dsh-tui` row that comes back under the entry's
 * screen after the previous one unloaded takes over the DSH side.
 *
 * On the DSH kernel the entry owns the screen; the profile's `dsh-tui` row
 * runs only the DSH side (`attachDsh`), and everything it mounts (presets,
 * ask_user, approvals, the assembly filters, the startup session's
 * listeners) lives on that row. When the row unloads (its `agents` service
 * went away) and applies again, the new row must mount those seams again and
 * reopen the ended session; a row applied while the previous one is still
 * mounted stays idle.
 *
 * The routing runs through the real `dsh-adapter/index.ts` `apply` on a real
 * Cordis tree; the slot's hooks are the real `row-attachment.ts` with
 * recording dependencies (the entry's runtime needs a terminal). How
 * `plugin.ts` fills those dependencies is pinned on its source.
 *
 *   A. a row that unloads before the Loader settled leaves the first attach
 *      to the next row [A0]; the first row gets `attachDsh` in a runtime
 *      fiber of its own [A1]
 *   B. a second row while the first is mounted stays idle [B1]
 *   C. after the first row unloads, a new row gets the reattach hook with its
 *      runtime context and config, reads the config, mounts the seams and
 *      only then reopens the ended session, and unloads with its row [C1-C3]
 *   R. the reattach hook: a live session is not reopened; a failed mount or
 *      reopen is reported, a failed mount reopens nothing; no hook once the
 *      screen is gone or before the channel is ready [R1-R4]
 *   P. plugin.ts: the first attach and the reattach share that attachment;
 *      its dependencies mount the seams and reopen the ended session outside
 *      the row's activation [P1-P2]
 *
 * Run: node --import tsx/esm scripts/verify-entry-row-reattach.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createEntrySlot, type EntrySlot } from '../src/dsh-adapter/entry-slot.js'
import { apply } from '../src/dsh-adapter/index.js'
import { createRowAttachment } from '../src/dsh-adapter/row-attachment.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
async function settled(predicate: () => boolean, rounds = 100): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    if (predicate()) return true
    await tick()
  }
  return predicate()
}

type Call = { step: string; ctx?: Context; config?: unknown; row: string }
const calls: Call[] = []
const steps = (): string[] => calls.map(call => call.step)
const slot: EntrySlot = createEntrySlot(true)
const state = { closed: false, ready: true, ended: false, failMount: false, failReopen: false }
const failures: unknown[] = []
let currentRow = ''
const attachment = createRowAttachment({
  closed: () => state.closed,
  ready: () => state.ready,
  readConfig: (config) => { calls.push({ step: 'config', config, row: currentRow }) },
  mountSeams: async (ctx) => {
    calls.push({ step: 'seams', ctx, row: currentRow })
    if (state.failMount) throw new Error('mount failed')
  },
  ended: () => state.ended,
  reopen: async () => {
    calls.push({ step: 'reopen', row: currentRow })
    if (state.failReopen) throw new Error('reopen failed')
    state.ended = false
  },
  failed: (error) => { failures.push(error) },
})
// The entry's first attach (plugin.ts) mounts the row's seams the same way.
slot.attachDsh = async (ctx, config) => {
  calls.push({ step: 'attach', ctx: ctx as Context, config, row: currentRow })
  await attachment.mount(ctx as Context)
}
slot.reattachDsh = attachment.reattach

const root = new Context()
// The Loader: held open for the first row, settled for every later one.
let settleLoader: () => void = () => {}
let loaderSettled: Promise<void> = new Promise(resolve => { settleLoader = resolve })
root.provide('loader', { await: () => loaderSettled })
const rowConfig = (model: string) => ({ model }) as never
async function mountRow(name: string, model: string): Promise<{ unload(): Promise<void> }> {
  currentRow = name
  const fiber = root.plugin({ name, apply: (ctx: Context) => apply(ctx, rowConfig(model)) } as never) as unknown as { dispose(): Promise<void> | void }
  await settled(() => false, 20)
  return { unload: async () => { await fiber.dispose() } }
}

try {
  // A row that unloads before its Loader settled never took the first attach.
  currentRow = 'row-0'
  const early = root.plugin({ name: 'row-0', apply: (ctx: Context) => apply(ctx, rowConfig('early-model')) } as never) as unknown as { dispose(): Promise<void> | void }
  const applied = await settled(() => slot.rowSeen)
  await early.dispose()
  settleLoader()
  loaderSettled = Promise.resolve()
  await settled(() => false, 20)
  check('A0 a row that unloads before the Loader settled leaves the first attach for the next row',
    applied && steps().length === 0 && slot.attachDsh !== undefined, { applied, steps: steps() })

  const first = await mountRow('row-1', 'first-model')
  check('A1 the first row gets attachDsh, in a runtime fiber of its own',
    await settled(() => steps().length === 2) && steps().join() === 'attach,seams' && calls[0]!.ctx !== root && slot.attachDsh === undefined,
    steps())

  calls.length = 0
  const second = await mountRow('row-2', 'second-model')
  check('B1 a second row while the first is mounted stays idle', steps().length === 0 && slot.reattachDsh?.() === undefined, steps())
  await second.unload()

  await first.unload()
  state.ended = true
  const third = await mountRow('row-3', 'third-model')
  check('C1 after the first row unloaded, a new row reads its own config, then mounts the seams, then reopens the ended session',
    await settled(() => steps().length === 3) && steps().join() === 'config,seams,reopen'
      && (calls[0]!.config as { model?: string } | undefined)?.model === 'third-model' && calls[1]!.row === 'row-3' && calls[1]!.ctx !== root
      && !state.ended && failures.length === 0,
    { steps: steps(), failures: failures.map(String) })
  check('C2 the returning row counts as mounted: a fourth row stays idle', slot.reattachDsh?.() === undefined)
  await third.unload()
  check('C3 the reattached row unloads with its fiber, and the hook is offered again', slot.reattachDsh?.() !== undefined)

  calls.length = 0
  const live = await mountRow('row-4', 'fourth-model')
  await settled(() => steps().length === 2)
  await settled(() => false, 10)
  check('R1 a row that comes back over a live session mounts the seams and reopens nothing',
    steps().join() === 'config,seams' && failures.length === 0,
    steps())
  await live.unload()

  calls.length = 0
  state.ended = true
  state.failMount = true
  const broken = await mountRow('row-5', 'fifth-model')
  await settled(() => failures.length === 1)
  check('R2 a failed seam mount is reported and reopens nothing',
    failures.length === 1 && String(failures[0]).includes('mount failed') && !steps().includes('reopen'), { steps: steps(), failures: failures.map(String) })
  await broken.unload()
  state.failMount = false

  calls.length = 0
  failures.length = 0
  state.failReopen = true
  const unopened = await mountRow('row-6', 'sixth-model')
  await settled(() => failures.length === 1)
  check('R3 a failed reopen is reported, the session stays ended',
    steps().join() === 'config,seams,reopen' && failures.length === 1 && String(failures[0]).includes('reopen failed') && state.ended,
    { steps: steps(), failures: failures.map(String) })
  await unopened.unload()
  state.failReopen = false

  state.ready = false
  const notReady = slot.reattachDsh?.()
  state.ready = true
  state.closed = true
  const closed = slot.reattachDsh?.()
  state.closed = false
  check('R4 no reattach before the channel is ready, nor once the screen is gone',
    notReady === undefined && closed === undefined && slot.reattachDsh?.() !== undefined)
} finally {
  await root.fiber.dispose()
}

// ── P: how plugin.ts fills the attachment ────────────────────────────────
{
  const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const start = plugin.indexOf('const rowAttachment = createRowAttachment({')
  const end = plugin.indexOf('entrySlot.attachDsh = async', start)
  const deps = start >= 0 && end > start ? plugin.slice(start, end) : ''
  const attachEnd = plugin.indexOf('const rowRoute', end)
  const attach = end >= 0 && attachEnd > end ? plugin.slice(end, attachEnd) : ''
  check('P1 the first attach and the reattach share the attachment, which mounts the seams',
    /entrySlot\.reattachDsh = rowAttachment\.reattach\b/.test(deps) && /await rowAttachment\.mount\(dshCtx\)/.test(attach)
      && /closed: \(\) => compositionFailed \|\| exited,/.test(deps) && /ready: \(\) => channel\.ready,/.test(deps)
      && /mountSeams: async \(dshCtx\) => \{\s*await installPresets\(dshCtx\)\s*const seams = mountDshQuestionSeams\(dshCtx\)[\s\S]*?mountDshApprovals\(dshCtx\)/.test(deps)
      && /readConfig: \(rowRuntimeConfig\) => \{ rowFacts\.config = configValues/.test(deps))
  check('P2 the reopen resumes the ended session as the entry (outside the row\'s activation)',
    /ended: \(\) => channel\.status === 'disposed',/.test(deps)
      && /reopen: async \(\) => \{\s*const result = await outsideActivation\(\(\) => channel\.resumeTo\(channel\.sessionId\)\)/.test(deps)
      && plugin.split('outsideActivation(').length - 1 === 1)
}

console.log(`\n${passed} checks passed`)
