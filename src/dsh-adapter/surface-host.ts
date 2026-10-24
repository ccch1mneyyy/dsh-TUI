/**
 * The host API every plugin surface shares (docs/plugin-ui-kit-design.md 二期).
 *
 * Side panels (`TuiPanelHostApi`) and full-screen scenes (`TuiSceneHostApi`)
 * expose the same navigation verbs — open another session, preview a file,
 * copy, deep-link one's own panel/scene with params — so a plugin view can
 * move between surfaces without a second code path. The types live here; the
 * implementations live next to each runtime (`pluginPanelAdapter.tsx` for
 * panels, `channel-scene-outlet.ts` for scenes) and call the shared helpers
 * below so the two surfaces cannot drift apart.
 *
 * Every verb is plugin-facing and refuses instead of throwing: invalid input,
 * a missing service, the adapter shadow policy or a rate limit answers
 * `false` (and warns in the log).
 */

import React from 'react'
import { assertCapabilityShadowPolicy, type AdapterRuntimeOptions } from '../adapter/kernel/runtime.js'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import { setClipboard } from '../ink/termio/osc.js'
import { t } from '../i18n.js'
import { resumeFailureText } from '../sessions/resumeFailure.js'
import { resolveTargetPath } from '../utils/fileTarget.js'

/** A JSON value: what surface params (deep links) may carry. */
export type TuiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly TuiJsonValue[]
  | { readonly [key: string]: TuiJsonValue }

export interface TuiSurfaceOpenFileOptions {
  /** 1-based line to scroll to and mark. */
  readonly line?: number
}

/**
 * Navigation verbs shared by panels and scenes (experimental).
 *
 * - `openSession` goes through the exact `/resume` path (`channel.resumeTo`):
 *   the `tui/session-switch` decision event, the stale-drop and the same
 *   notices. At most one call per 2s per plugin.
 * - `openFile` opens the host-owned read-only preview (never executes).
 * - `copy` writes the system clipboard: at most once per second per plugin,
 *   refused in the adapter shadow modes.
 * - `openScene` / `openPanel` only reach the caller's own registrations; the
 *   optional `params` are validated JSON (≤16 KiB), frozen, and read back by
 *   the opened surface through `useParams()`.
 */
export interface TuiSurfaceHostApi {
  /** Switch the screen to a persisted session; resolves false when refused,
   *  cancelled, unavailable or rate limited. Already on screen → true. */
  openSession(sessionId: string): Promise<boolean>
  /** Host-owned read-only preview; relative paths resolve against the session cwd. */
  openFile(path: string, options?: TuiSurfaceOpenFileOptions): boolean
  /** Copy to the system clipboard (OSC 52 + native fallback); the host notes it. */
  copy(text: string): boolean
  /** Open one of the caller's own scenes, optionally with deep-link params. */
  openScene(id: string, params?: TuiJsonValue): boolean
  /** Open one of the caller's own panels, optionally with deep-link params. */
  openPanel(id: string, params?: TuiJsonValue): boolean
  /** Hook: the params this surface was last opened with; re-renders on change. */
  useParams(): TuiJsonValue | undefined
  toast(text: string): boolean
}

/** Optional context a host passes when it renders a scene (Chat owns both). */
export interface TuiSceneRenderContext {
  readonly activity?: import('./activity-store.js').ActivityView
  readonly attention?: { readonly approvals: number; readonly questions: number }
}

/** Serialized (UTF-8) cap for one params value. */
export const SURFACE_PARAMS_MAX_BYTES = 16 * 1024
/** Nesting cap: deeper values are refused rather than walked. */
export const SURFACE_PARAMS_MAX_DEPTH = 32
/** `openSession` rate limit per plugin activation. */
export const OPEN_SESSION_RATE_LIMIT_MS = 2_000
/** `copy` text cap (UTF-16 code units). */
export const COPY_MAX_CHARS = 1_048_576
/** `copy` rate limit per plugin activation. */
export const COPY_RATE_LIMIT_MS = 1_000
/** `openFile` path cap (UTF-16 code units). */
export const OPEN_FILE_MAX_PATH = 4096
const SESSION_ID_MAX = 256

// ── params: validation + frozen deep copy ──────────────────────────────────

export type SurfaceParamsResult =
  | { readonly ok: true; readonly value: TuiJsonValue | undefined }
  | { readonly ok: false; readonly reason: string }

class ParamsError extends Error {}

/** Running lower bound of the serialized size, spent while copying. */
interface CopyBudget {
  used: number
}

/**
 * Spend `bytes` of the params budget and refuse as soon as it is exceeded.
 * Every charge is a LOWER bound of what JSON.stringify writes for that piece
 * (a string's UTF-16 length never exceeds its UTF-8 size; escapes only add),
 * so an early refusal is one the exact check would have made anyway — it
 * just comes before the walk visits every path of a value that shares one
 * array many levels deep (`x = [x, x]` 22 deep is 2^22 nodes to copy).
 */
function spend(budget: CopyBudget, bytes: number): void {
  budget.used += bytes
  if (budget.used > SURFACE_PARAMS_MAX_BYTES) {
    throw new ParamsError('serialized size exceeds ' + SURFACE_PARAMS_MAX_BYTES + ' bytes')
  }
}

function copyJson(value: unknown, depth: number, ancestors: Set<object>, budget: CopyBudget): TuiJsonValue {
  if (value === null) {
    spend(budget, 4)
    return value
  }
  if (typeof value === 'boolean') {
    spend(budget, value ? 4 : 5)
    return value
  }
  if (typeof value === 'string') {
    spend(budget, value.length + 2)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ParamsError('non-finite number')
    spend(budget, 1)
    return value
  }
  if (typeof value !== 'object') throw new ParamsError('unsupported ' + typeof value + ' value')
  if (depth >= SURFACE_PARAMS_MAX_DEPTH) throw new ParamsError('nesting deeper than ' + SURFACE_PARAMS_MAX_DEPTH)
  if (ancestors.has(value)) throw new ParamsError('cyclic value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      // Brackets and separators up front: a huge array is refused unwalked.
      spend(budget, 2 + Math.max(0, value.length - 1))
      const out: TuiJsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index]
        if (item === undefined) throw new ParamsError('undefined array element')
        out.push(copyJson(item, depth + 1, ancestors, budget))
      }
      return Object.freeze(out)
    }
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new ParamsError('only plain objects and arrays are allowed')
    spend(budget, 2)
    const out: Record<string, TuiJsonValue> = {}
    let entries = 0
    for (const key of Object.keys(value)) {
      const item: unknown = (value as Record<string, unknown>)[key]
      // JSON drops undefined properties; so do we (they cost nothing).
      if (item === undefined) continue
      // `"key":` plus the separator before every entry but the first.
      spend(budget, key.length + 3 + (entries > 0 ? 1 : 0))
      entries += 1
      // defineProperty keeps a `__proto__` key an own data property instead
      // of rewriting the copy's prototype.
      Object.defineProperty(out, key, { value: copyJson(item, depth + 1, ancestors, budget), enumerable: true, writable: false, configurable: false })
    }
    return Object.freeze(out)
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Validate untrusted params as JSON and return a frozen deep copy. Functions,
 * symbols, bigints, cycles, class instances and non-finite numbers are
 * refused; so is anything over {@link SURFACE_PARAMS_MAX_BYTES} serialized —
 * refused during the copy as soon as a running lower bound passes the budget,
 * then confirmed exactly on the (by then bounded) copy.
 */
export function freezeSurfaceParams(input: unknown): SurfaceParamsResult {
  if (input === undefined) return { ok: true, value: undefined }
  let value: TuiJsonValue
  try {
    value = copyJson(input, 0, new Set(), { used: 0 })
  } catch (error) {
    if (error instanceof ParamsError) return { ok: false, reason: error.message }
    return { ok: false, reason: 'unreadable value' }
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > SURFACE_PARAMS_MAX_BYTES) {
    return { ok: false, reason: 'serialized size ' + bytes + ' exceeds ' + SURFACE_PARAMS_MAX_BYTES + ' bytes' }
  }
  return { ok: true, value }
}

// ── params store: one slot per surface, read through useParams() ──────────

interface ParamsSlot {
  readonly value: TuiJsonValue
  /** Serialized form: a re-open with deep-equal params keeps the old identity. */
  readonly json: string
}

const paramsSlots = new Map<string, ParamsSlot>()
const paramsListeners = new Map<string, Set<() => void>>()

export function panelParamsKey(panelId: string): string {
  return 'panel\u0000' + panelId
}

/** One number per scene registry: scene ids are per composition (each
 *  TuiSceneRuntime keeps its own), unlike panel ids, whose store is
 *  process-wide — so scene params are keyed by the registry too. */
const sceneScopeIds = new WeakMap<object, number>()
let nextSceneScopeId = 0

export function sceneParamsKey(scope: object, sceneId: string): string {
  let scopeId = sceneScopeIds.get(scope)
  if (scopeId === undefined) {
    nextSceneScopeId += 1
    scopeId = nextSceneScopeId
    sceneScopeIds.set(scope, scopeId)
  }
  return 'scene\u0000' + scopeId + '\u0000' + sceneId
}

export function getSurfaceParams(key: string): TuiJsonValue | undefined {
  return paramsSlots.get(key)?.value
}

/**
 * Store already-validated params (from {@link freezeSurfaceParams}). Notifies
 * only when the value changed: deep-equal params keep the previous identity,
 * so a plugin effect keyed on them does not re-run on a repeated open.
 */
export function setSurfaceParams(key: string, value: TuiJsonValue | undefined): void {
  const current = paramsSlots.get(key)
  if (value === undefined) {
    if (current === undefined) return
    paramsSlots.delete(key)
  } else {
    const json = JSON.stringify(value)
    if (current !== undefined && current.json === json) return
    paramsSlots.set(key, { value, json })
  }
  for (const listener of [...(paramsListeners.get(key) ?? [])]) listener()
}

export function clearSurfaceParams(key: string): void {
  setSurfaceParams(key, undefined)
}

export function subscribeSurfaceParams(key: string, listener: () => void): () => void {
  let set = paramsListeners.get(key)
  if (set === undefined) {
    set = new Set()
    paramsListeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = paramsListeners.get(key)
    if (current === undefined) return
    current.delete(listener)
    if (current.size === 0) paramsListeners.delete(key)
  }
}

/** The `useParams()` hook body: must run inside the surface's render. */
export function useSurfaceParams(key: string): TuiJsonValue | undefined {
  const subscribe = React.useCallback((listener: () => void) => subscribeSurfaceParams(key, listener), [key])
  return React.useSyncExternalStore(subscribe, () => getSurfaceParams(key))
}

// ── openSession: the /resume path, rate limited per plugin ─────────────────

type SessionChannel = Pick<ChannelUi, 'resumeTo' | 'notify' | 'sessionId'>

const lastSessionOpen = new WeakMap<object, number>()

/**
 * `openSession` for one plugin activation (`caller`). `host.surface.open-session`
 * is a mutate capability (it switches the session on screen), so a shadow
 * mode refuses it before anything else; validation and the rate limit then
 * refuse synchronously (warned); the switch itself is `channel.resumeTo` —
 * the same transaction `/resume` and the session browser use — and its
 * refusals surface through the same sentences (`resumeFailureText`).
 */
export async function surfaceOpenSession(
  caller: SurfaceCaller | undefined,
  channel: SessionChannel | undefined,
  sessionId: unknown,
  warn: (message: string) => void,
): Promise<boolean> {
  if (caller === undefined || channel === undefined) return false
  try {
    assertCapabilityShadowPolicy('host.surface.open-session', caller.runtime.mode, caller.runtime.slices)
  } catch {
    warn('dsh-tui: openSession refused by the adapter shadow policy')
    return false
  }
  const { owner } = caller
  // eslint-disable-next-line no-control-regex -- session ids are plain tokens
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > SESSION_ID_MAX || /[\x00-\x1f\x7f]/u.test(sessionId)) {
    warn('dsh-tui: openSession rejected an invalid session id')
    return false
  }
  if (sessionId === channel.sessionId) return true
  const now = Date.now()
  const last = lastSessionOpen.get(owner)
  if (last !== undefined && now - last < OPEN_SESSION_RATE_LIMIT_MS) {
    warn('dsh-tui: openSession dropped — rate limited to one call per ' + OPEN_SESSION_RATE_LIMIT_MS + 'ms')
    return false
  }
  lastSessionOpen.set(owner, now)
  let result: Awaited<ReturnType<SessionChannel['resumeTo']>>
  try {
    result = await channel.resumeTo(sessionId)
  } catch (error) {
    channel.notify(t('session-resume-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
    return false
  }
  if (!result.ok) {
    const text = resumeFailureText(result)
    if (text !== undefined) channel.notify(text, { color: 'error', timeoutMs: 8000 })
    return false
  }
  channel.notify(t('resume-resumed'))
  return true
}

// ── openFile: validate + resolve, then hand to the preview opener ──────────

export interface SurfaceFileRequest {
  /** Absolute path (resolved against the session cwd). */
  readonly path: string
  readonly line?: number
}

/** Validate an untrusted openFile call; undefined (+ warn) when refused. */
export function resolveSurfaceFileRequest(
  cwd: string | undefined,
  path: unknown,
  options: unknown,
  warn: (message: string) => void,
): SurfaceFileRequest | undefined {
  if (typeof path !== 'string' || path.trim() === '' || path.length > OPEN_FILE_MAX_PATH || path.includes('\u0000')) {
    warn('dsh-tui: openFile rejected an invalid path')
    return undefined
  }
  let line: number | undefined
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object') {
      warn('dsh-tui: openFile rejected invalid options')
      return undefined
    }
    const raw = (options as { line?: unknown }).line
    if (raw !== undefined) {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 10_000_000) {
        warn('dsh-tui: openFile rejected an invalid line (expected a positive integer)')
        return undefined
      }
      line = raw
    }
  }
  // The validated path as given: a filename may legitimately start or end
  // with spaces, and trimming would preview a different file.
  const resolved = resolveTargetPath(path, cwd !== undefined && cwd !== '' ? cwd : process.cwd())
  return line === undefined ? { path: resolved } : { path: resolved, line }
}

// ── copy: the shared clipboard path (OSC 52 + native safety net) ───────────

/** The activation a surface verb acts as. */
export interface SurfaceCaller {
  /** `activationFiber` of the registering activation (the rate-limit key). */
  readonly owner: object
  /** Its composition's shadow-policy snapshot (`adapterRuntimeFor`). */
  readonly runtime: AdapterRuntimeOptions
}

const lastCopy = new WeakMap<object, number>()

/**
 * Copy plugin text through the same path every host copy uses: `setClipboard`
 * builds the OSC 52 (tmux-wrapped when needed) and fires the native utility;
 * the returned sequence is written through the renderer's raw channel.
 *
 * `host.surface.copy` is a mutate capability (the system clipboard, a
 * subprocess, a host notice), so a shadow mode refuses it with `false`. The
 * text is validated before anything else runs, and each activation copies at
 * most once per {@link COPY_RATE_LIMIT_MS} (a refused call does not use the
 * window). A caller without a plugin identity (a host-owned scene) is refused.
 */
export function surfaceCopy(
  caller: SurfaceCaller | undefined,
  text: unknown,
  writeRaw: ((data: string) => void) | null | undefined,
  notify: ((text: string) => void) | undefined,
  warn: (message: string) => void,
): boolean {
  if (caller === undefined) return false
  try {
    assertCapabilityShadowPolicy('host.surface.copy', caller.runtime.mode, caller.runtime.slices)
  } catch {
    warn('dsh-tui: copy refused by the adapter shadow policy')
    return false
  }
  if (typeof text !== 'string' || text === '' || text.length > COPY_MAX_CHARS) {
    warn('dsh-tui: copy rejected the text (expected a non-empty string up to ' + COPY_MAX_CHARS + ' chars)')
    return false
  }
  const now = Date.now()
  const last = lastCopy.get(caller.owner)
  if (last !== undefined && now - last < COPY_RATE_LIMIT_MS) {
    warn('dsh-tui: copy dropped — rate limited to one call per ' + COPY_RATE_LIMIT_MS + 'ms')
    return false
  }
  lastCopy.set(caller.owner, now)
  void setClipboard(text).then(raw => { if (raw !== '') writeRaw?.(raw) }).catch(() => {})
  // A third-party write to the clipboard is always announced by the host.
  notify?.(t('copied-chars', { n: text.length }))
  return true
}
