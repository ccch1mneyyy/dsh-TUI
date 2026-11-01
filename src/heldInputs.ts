/**
 * `/restart` carry-over of the composer queue (#1651): the queued and held
 * texts the old process still showed are written to a per-restart file whose
 * path rides the replacement's env, and the replacement parks them as held
 * dock rows. The backend copies die with the old process (the kernel records
 * them as canceled), so nothing re-sends them until the user sends the dock.
 * Text only: staged images live in the old process's memory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

/** env marker naming the file the replacement takes its held texts from. */
export const HELD_INPUTS_ENV = 'DSH_TUI_HELD_INPUTS'

const HELD_INPUTS_FILE = /^held-inputs-\d+-[0-9a-f]{12}\.json$/u
/** A restart that stalled leaves its file for the printed resume command; one
 *  nobody resumed within this long is swept at a later launch. */
const HELD_INPUTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Write the texts for a replacement process to take.
 * @returns The env marker to hand the replacement, or undefined when there
 *   is nothing to carry or the write failed (best effort: a restart never
 *   waits on it).
 */
export function writeHeldInputs(texts: readonly string[], dir: string = DATA_DIR, pid: number = process.pid): Record<string, string> | undefined {
  const kept = texts.filter(text => text.trim() !== '')
  if (kept.length === 0) return undefined
  // Unique per restart: a stalled restart's file stays for its printed
  // resume command, and a later process reusing the pid must not replace it.
  const file = join(dir, `held-inputs-${pid}-${randomBytes(6).toString('hex')}.json`)
  try {
    mkdirSync(dir, { recursive: true })
    // The user's own prompt text: readable by them alone.
    writeFileSync(file, JSON.stringify({ texts: kept }), { mode: 0o600, flag: 'wx' })
    return { [HELD_INPUTS_ENV]: file }
  } catch {
    return undefined
  }
}

/**
 * The one handoff this process has not settled yet. The DSH launcher's boot
 * recompose applies the entry a second time, after the first pass consumed
 * the env marker; that pass must still find the texts.
 */
let waiting: { texts: string[]; file?: string } | undefined

/** Read the marker once per handoff; without a fresh one, hand back the
 *  pending handoff (the recompose asking again). */
function carriedInputs(env: NodeJS.ProcessEnv, dir: string): { texts: string[]; file?: string } {
  if (env[HELD_INPUTS_ENV] !== undefined) waiting = readHeldInputs(env, dir)
  return waiting ?? { texts: [] }
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
 * The replacement's side: park the texts a `/restart` handed this process as
 * held rows once the screen's channel is ready (never sent by themselves).
 * A pass that cannot reach a ready channel leaves the handoff pending for the
 * next `apply()` instead of dropping it.
 * @returns What stops waiting for a channel that is not ready yet.
 */
export function adoptHeldInputs(
  channel: { readonly ready: boolean; subscribe(listener: () => void): () => void; holdInputs(texts: readonly string[]): number },
  env: NodeJS.ProcessEnv = process.env,
  dir: string = DATA_DIR,
): (() => void) | undefined {
  const inputs = carriedInputs(env, dir)
  const { texts, file } = inputs
  // The file goes only once its texts are on screen: a replacement that
  // dies before its channel is ready leaves it for the resume command its
  // parent prints. Then files nobody resumed are swept.
  const settle = (): void => {
    if (file !== undefined) removeHeldFile(file)
    waiting = undefined
    sweepHeldInputs(dir)
  }
  if (texts.length === 0) {
    settle()
    return undefined
  }
  if (channel.ready) {
    channel.holdInputs(texts)
    settle()
    return undefined
  }
  const unsubscribe = channel.subscribe(() => {
    if (!channel.ready) return
    unsubscribe()
    // A later apply may have taken the handoff first (the recompose); the
    // same texts must never be parked twice.
    if (waiting !== inputs) return
    channel.holdInputs(texts)
    settle()
  })
  return unsubscribe
}

/**
 * The resume command after a restart that ended before any replacement took
 * the held texts (a stall, a failed spawn): their file stays, and the command
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
 * Take (read and delete) the texts a `/restart` handed this process. One
 * shot: the env marker is consumed too, so no child inherits it.
 */
export function takeHeldInputs(env: NodeJS.ProcessEnv = process.env, dir: string = DATA_DIR): string[] {
  const marked = env[HELD_INPUTS_ENV] !== undefined
  const { texts, file } = readHeldInputs(env, dir)
  if (file !== undefined) removeHeldFile(file)
  if (marked) waiting = undefined
  return texts
}

/** Read the texts and consume the env marker; `file` is what the caller
 *  deletes once it is done with them. */
function readHeldInputs(env: NodeJS.ProcessEnv, dir: string): { texts: string[]; file?: string } {
  const file = env[HELD_INPUTS_ENV]
  delete env[HELD_INPUTS_ENV]
  // Only ever a file writeHeldInputs named, in the directory it writes to:
  // the marker is env input, and the caller deletes what it names.
  if (file === undefined || !HELD_INPUTS_FILE.test(basename(file)) || dirname(resolve(file)) !== resolve(dir)) return { texts: [] }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const texts = parsed !== null && typeof parsed === 'object' ? (parsed as { texts?: unknown }).texts : undefined
    return { texts: Array.isArray(texts) ? texts.filter((text): text is string => typeof text === 'string' && text.trim() !== '') : [], file }
  } catch {
    return { texts: [], file }
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
