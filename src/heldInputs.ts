/**
 * `/restart` carry-over of the composer queue (#1651): the queued and held
 * texts the old process still showed are written to a per-restart file whose
 * path rides the replacement's env, and the replacement parks them as held
 * dock rows. The backend copies die with the old process (the kernel records
 * them as canceled), so nothing re-sends them until the user sends the dock.
 * Staged images live in the old process's memory: their bytes ride the file
 * and the replacement stages them again.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChannelImageMediaType, ComposerImageRef, ComposerSubmission, StagedImageHandle, StagedImageInput, TranscriptImage } from './adapter/ports/channel-view.js'
import { sniffImageMediaType } from './utils/imageResize.js'
import { DATA_DIR } from './utils/paths.js'

/** env marker naming the file the replacement takes its held inputs from. */
export const HELD_INPUTS_ENV = 'DSH_TUI_HELD_INPUTS'

const HELD_INPUTS_FILE = /^held-inputs-\d+-[0-9a-f]{12}\.json$/u
/** A restart that stalled leaves its file for the printed resume command; one
 *  nobody resumed within this long is swept at a later launch. */
const HELD_INPUTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** One staged image of a carried input: its visible token and its bytes. */
export interface HeldImage {
  readonly token: string
  readonly data: Uint8Array
  readonly mediaType: ChannelImageMediaType
  readonly name?: string
}

/** One carried input. */
export interface HeldInput {
  readonly text: string
  readonly images?: readonly HeldImage[]
}

/** How long one image read may take before the restart goes on without it. */
const IMAGE_READ_MS = 2000

/**
 * The old process's side: the pending rows with their staged images' bytes.
 * Never rejects; an image that cannot be read in time stays behind (its token
 * then sends as text, which the composer warns about).
 */
export async function collectHeldInputs(
  pending: readonly { readonly text: string; readonly images: readonly ComposerImageRef[] }[],
  stagedImage: (stageId: string) => TranscriptImage | undefined,
): Promise<HeldInput[]> {
  const readImage = async (ref: ComposerImageRef): Promise<HeldImage | undefined> => {
    const image = stagedImage(ref.stageId)
    if (image === undefined) return undefined
    // A ref'd timer, unlike AbortSignal.timeout: while the exit waits on this
    // read the process must stay up until the replacement is spawned.
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const data = await Promise.race([
        image.read(abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort()
            reject(new Error('image read timed out'))
          }, IMAGE_READ_MS)
        }),
      ])
      const mediaType = sniffImageMediaType(data)
      if (mediaType === undefined) return undefined
      return { token: ref.token, data, mediaType, ...(image.name === undefined ? {} : { name: image.name }) }
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  return Promise.all(pending.map(async item => {
    const images = (await Promise.all(item.images.map(readImage))).filter((image): image is HeldImage => image !== undefined)
    return images.length === 0 ? { text: item.text } : { text: item.text, images }
  }))
}

/**
 * Write the inputs for a replacement process to take.
 * @returns The env marker to hand the replacement, or undefined when there
 *   is nothing to carry or the write failed (best effort: a restart never
 *   waits on it).
 */
export function writeHeldInputs(inputs: readonly (string | HeldInput)[], dir: string = DATA_DIR, pid: number = process.pid): Record<string, string> | undefined {
  const kept = inputs.map(input => typeof input === 'string' ? { text: input } : input).filter(input => input.text.trim() !== '')
  if (kept.length === 0) return undefined
  // Unique per restart: a stalled restart's file stays for its printed
  // resume command, and a later process reusing the pid must not replace it.
  const file = join(dir, `held-inputs-${pid}-${randomBytes(6).toString('hex')}.json`)
  try {
    mkdirSync(dir, { recursive: true })
    const records = kept.map(input => input.images === undefined || input.images.length === 0 ? { text: input.text } : {
      text: input.text,
      images: input.images.map(image => ({ ...image, data: Buffer.from(image.data).toString('base64') })),
    })
    // The user's own prompt text and images: readable by them alone.
    writeFileSync(file, JSON.stringify({ inputs: records }), { mode: 0o600, flag: 'wx' })
    return { [HELD_INPUTS_ENV]: file }
  } catch {
    return undefined
  }
}

/** What `adoptHeldInputs` needs from the screen's channel. */
export interface HeldInputsChannel {
  readonly ready: boolean
  subscribe(listener: () => void): () => void
  holdInputs(inputs: readonly (string | ComposerSubmission)[]): number
  stagedImageGeneration(): number
  stageComposerImage(input: StagedImageInput, generation: number): Promise<StagedImageHandle>
}

/**
 * The one handoff this process has not settled yet. The DSH launcher's boot
 * recompose applies the entry a second time, after the first pass consumed
 * the env marker; that pass must still find the inputs. A pass claims it
 * before holding: staging images is async, and a stale listener must not park
 * the same inputs again while the first pass is still staging.
 */
let waiting: { inputs: HeldInput[]; file?: string; claimed?: boolean } | undefined

/**
 * Passes that asked for the handoff while another one was staging its images.
 * Staging is async, so the holder can stop (a replaced screen, a failed
 * boot pass) before it parks anything: it releases the claim, and without a
 * wake-up here the ready sibling that already lost the race would never look
 * again — its inputs would stay on disk with nobody holding them.
 */
const claimWaiters = new Set<() => void>()

/** Read the marker once per handoff; without a fresh one, hand back the
 *  pending handoff (the recompose asking again). */
function carriedInputs(env: NodeJS.ProcessEnv, dir: string): { inputs: HeldInput[]; file?: string; claimed?: boolean } {
  if (env[HELD_INPUTS_ENV] !== undefined) waiting = readHeldInputs(env, dir)
  return waiting ?? { inputs: [] }
}

/** The write side of a carried image, bounded like the read side: a channel
 *  that never answers must not keep the handoff claim forever. */
function stageWithin<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('image staging timed out')), IMAGE_READ_MS)
    // A guard for an exit path musn't keep the process up by itself.
    timer.unref?.()
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Best effort: a file another process still holds open must not decide
 *  whether this one starts. */
function removeHeldFile(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
  }
}

/**
 * The replacement's side: park the inputs a `/restart` handed this process as
 * held rows once the screen's channel is ready (never sent by themselves),
 * their images staged again first. An image the new session refuses is left
 * out; its token stays in the text. A pass that cannot reach a ready channel
 * leaves the handoff pending for the next `apply()` instead of dropping it.
 * @returns What stops the adoption, or undefined when nothing was carried.
 */
export function adoptHeldInputs(channel: HeldInputsChannel, env: NodeJS.ProcessEnv = process.env, dir: string = DATA_DIR): (() => void) | undefined {
  const handoff = carriedInputs(env, dir)
  const { inputs, file } = handoff
  // The file goes only once its inputs are on screen: a replacement that
  // dies (or stops) before then, staging images included, leaves it for the
  // resume command its parent prints. Then files nobody resumed are swept.
  const settle = (): void => {
    if (file !== undefined) removeHeldFile(file)
    waiting = undefined
    claimWaiters.clear()
    sweepHeldInputs(dir)
  }
  if (inputs.length === 0) {
    settle()
    return undefined
  }
  let stopped = false
  /** Hand the claim back and wake the pass that lost it. The file is still on
   *  disk: only a pass that actually parks the inputs may settle the handoff. */
  const release = (): void => {
    if (waiting !== handoff) return
    handoff.claimed = false
    for (const wake of [...claimWaiters]) {
      claimWaiters.delete(wake)
      wake()
    }
  }
  const hold = async (): Promise<void> => {
    let generation: number
    try {
      generation = channel.stagedImageGeneration()
    } catch {
      // The screen is gone before staging even started: nobody here can park
      // the rows. Keep the file and let the next pass (or the resume command)
      // take the handoff instead of leaving the claim held.
      release()
      return
    }
    const submissions = await Promise.all(inputs.map(async (input): Promise<ComposerSubmission> => {
      if (input.images === undefined) return { text: input.text }
      const refs = await Promise.all(input.images.map(async (image): Promise<ComposerImageRef | undefined> => {
        try {
          const { stageId } = await stageWithin(channel.stageComposerImage({ data: image.data, mediaType: image.mediaType, ...(image.name === undefined ? {} : { name: image.name }) }, generation))
          return { token: image.token, stageId }
        } catch {
          return undefined
        }
      }))
      const images = refs.filter((ref): ref is ComposerImageRef => ref !== undefined)
      return images.length === 0 ? { text: input.text } : { text: input.text, images }
    }))
    if (stopped) {
      // Nothing was parked: hand the claim back so a later apply (the entry's
      // next boot pass) can still take these inputs. The file is still there.
      release()
      return
    }
    try {
      channel.holdInputs(submissions)
    } catch {
      // The screen refused the rows (disposed mid-staging): keep the file for
      // the resume command and let a later pass take the handoff.
      release()
      return
    }
    settle()
  }
  // Whoever holds first owns the handoff, and owns it from before the async
  // staging starts: a stale listener whose channel turns ready mid-staging
  // must not park the same inputs a second time.
  const claim = (): boolean => {
    if (handoff.claimed === true || waiting !== handoff) return false
    handoff.claimed = true
    return true
  }
  const take = (): void => {
    if (stopped || waiting !== handoff) return
    if (!claim()) {
      // A sibling pass owns the handoff and is staging images; it may stop
      // before it parks anything, so wait to be woken instead of returning.
      claimWaiters.add(take)
      return
    }
    claimWaiters.delete(take)
    // A throw outside the per-image catch must not leave the claim held.
    void hold().catch(() => { release() })
  }
  const stop = (): void => {
    stopped = true
    claimWaiters.delete(take)
  }
  if (channel.ready) {
    take()
    return stop
  }
  const unsubscribe = channel.subscribe(() => {
    if (!channel.ready) return
    unsubscribe()
    take()
  })
  return () => {
    stop()
    unsubscribe()
  }
}

/**
 * The resume command after a restart that ended before any replacement took
 * the held inputs (a stall, a failed spawn): their file stays, and the command
 * hands it to the next launch. Windows has no shared env-assignment syntax:
 * PowerShell and cmd.exe each get their own copy-pasteable line.
 */
export function heldInputsResumeCommand(command: string, env: Readonly<Record<string, string>> | undefined, platform: NodeJS.Platform = process.platform): string {
  const file = env?.[HELD_INPUTS_ENV]
  if (file === undefined || !existsSync(file)) return command
  if (platform === 'win32') {
    // This line is the only way a stalled restart gets its texts back, and the
    // two Windows shells disagree on how to set a variable: print both.
    return `$env:${HELD_INPUTS_ENV}='${file.replaceAll('\'', '\'\'')}'; ${command}\nset "${HELD_INPUTS_ENV}=${file}" && ${command}`
  }
  return `${HELD_INPUTS_ENV}='${file.replaceAll('\'', '\'\\\'\'')}' ${command}`
}

/**
 * Take (read and delete) the inputs a `/restart` handed this process. One
 * shot: the env marker is consumed too, so no child inherits it.
 */
export function takeHeldInputs(env: NodeJS.ProcessEnv = process.env, dir: string = DATA_DIR): HeldInput[] {
  const marked = env[HELD_INPUTS_ENV] !== undefined
  const { inputs, file } = readHeldInputs(env, dir)
  if (file !== undefined) removeHeldFile(file)
  if (marked) {
    waiting = undefined
    claimWaiters.clear()
  }
  return inputs
}

const heldImageOf = (value: unknown): HeldImage | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const { token, data, name } = value as { token?: unknown; data?: unknown; name?: unknown }
  if (typeof token !== 'string' || typeof data !== 'string') return undefined
  const bytes = new Uint8Array(Buffer.from(data, 'base64'))
  // The bytes decide the type, not the file's word for it.
  const mediaType = sniffImageMediaType(bytes)
  if (mediaType === undefined) return undefined
  return { token, data: bytes, mediaType, ...(typeof name === 'string' ? { name } : {}) }
}

/** Read the inputs and consume the env marker; `file` is what the caller
 *  deletes once it is done with them. */
function readHeldInputs(env: NodeJS.ProcessEnv, dir: string): { inputs: HeldInput[]; file?: string } {
  const file = env[HELD_INPUTS_ENV]
  delete env[HELD_INPUTS_ENV]
  // Only ever a file writeHeldInputs named, in the directory it writes to:
  // the marker is env input, and the caller deletes what it names.
  if (file === undefined || !HELD_INPUTS_FILE.test(basename(file)) || dirname(resolve(file)) !== resolve(dir)) return { inputs: [] }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const record = parsed !== null && typeof parsed === 'object' ? (parsed as { inputs?: unknown; texts?: unknown }) : undefined
    // A file an older build wrote holds `{texts: [...]}` (and no images). The
    // resume command that build printed still names it: read it instead of
    // deleting the queued texts as an empty handoff.
    const inputs = record?.inputs ?? record?.texts
    if (!Array.isArray(inputs)) return { inputs: [], file }
    return {
      inputs: inputs.flatMap((input: unknown): HeldInput[] => {
        if (typeof input === 'string') return input.trim() === '' ? [] : [{ text: input }]
        if (input === null || typeof input !== 'object') return []
        const { text, images } = input as { text?: unknown; images?: unknown }
        if (typeof text !== 'string' || text.trim() === '') return []
        const held = Array.isArray(images) ? images.map(heldImageOf).filter((image): image is HeldImage => image !== undefined) : []
        return [held.length === 0 ? { text } : { text, images: held }]
      }),
      file,
    }
  } catch {
    return { inputs: [], file }
  }
}

/** Remove held-input files older than the resume window (best effort). */
export function sweepHeldInputs(dir: string = DATA_DIR, now: number = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!HELD_INPUTS_FILE.test(name)) continue
    const file = join(dir, name)
    try {
      if (now - statSync(file).mtimeMs > HELD_INPUTS_MAX_AGE_MS) rmSync(file, { force: true })
    } catch {
    }
  }
}
