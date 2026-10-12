/**
 * The hand-off between this package's entry and the runtime it mounts. On the
 * DSH kernel the slot is also published for the profile's `dsh-tui` row in the
 * same Cordis root: the row then runs only the DSH side through `attachDsh`
 * (without a published slot it takes its usual path). On `globalThis` +
 * `Symbol.for` so a row loaded from another copy of this package still meets
 * the entry. Other kernels keep it private: the entry composes the light profile.
 */

/** Hooks are filled by the entry's runtime. */
export interface EntrySlot {
  /** The DSH kernel: the screen waits for the row's `attachDsh`. */
  readonly dsh: boolean
  /** Set by the row as soon as it applies, so the entry can tell whether a
   *  `dsh-tui` row exists once the composition settled. */
  rowSeen: boolean
  /** The DSH side. The row calls it once, after the Loader settled; it never
   *  throws (a failure lands in the mounted screen). */
  attachDsh?: (ctx: unknown, runtimeConfig: unknown, configOwner: unknown) => Promise<void>
  /** DSH: the composition failed or had no `dsh-tui` row, the startup session
   *  will never come. `logPath` is the saved startup report, if any. */
  composeFailed?: (error: unknown, logPath?: string) => void
  /** The composition settled (DSH: with a `dsh-tui` row, so a startup open
   *  that failed meanwhile is that open's failure); re-reads mount-time
   *  resolutions of services composed after the mount. */
  composeSucceeded?: () => void
  /** Resolves once the screen's first frame reached the terminal; awaited
   *  before the composition's synchronous stretch. */
  firstFrameFlushed?: () => Promise<void>
}

const ENTRY_SLOT_KEY = Symbol.for('@deepseek-harness-tui/dsh-tui:host-entry')

type SlotHost = typeof globalThis & { [ENTRY_SLOT_KEY]?: EntrySlot }

/** The entry's slot, published for the `dsh-tui` row on the DSH kernel. */
export function createEntrySlot(dsh: boolean): EntrySlot {
  const slot: EntrySlot = { dsh, rowSeen: false }
  if (dsh) (globalThis as SlotHost)[ENTRY_SLOT_KEY] = slot
  return slot
}

/** The published slot, if this process's entry mounted the screen. */
export function peekEntrySlot(): EntrySlot | undefined {
  return (globalThis as SlotHost)[ENTRY_SLOT_KEY]
}

/** Take the DSH-side hook once: a second row (or a recompose) finds none. */
export function takeEntryAttach(): EntrySlot['attachDsh'] {
  const slot = peekEntrySlot()
  const attach = slot?.attachDsh
  if (slot !== undefined) slot.attachDsh = undefined
  return attach
}
