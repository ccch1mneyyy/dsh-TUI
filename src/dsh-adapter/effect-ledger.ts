/**
 * Effect ledger (C-060): an append-only JSONL journal of plugin-visible
 * effects at `~/.dsh-tui/effect-ledger.jsonl`, mounted by the
 * dsh-tui-plugin-host row as `ctx.tuiEffectLedger`.
 *
 * Every record carries the lifecycle triple:
 *
 * - `pluginId` — derived from the verified Component identity bound to the
 *   PASSED activation. `'host'` is used for host/root records and
 *   `'undeclared'` for a plugin-facing call without a verified identity; a
 *   display fiber name is never trusted as authorization identity.
 * - `activationInstance` — stable per cordis fiber for the lifetime of this
 *   process (first-seen assignment from a WeakMap), so a hot-reloaded plugin
 *   shows up as a NEW instance while all effects of one activation share one
 *   id.
 * - `runtimeGenerationId` — the plugin-host row's generation (C-050), so
 *   records from different process generations can never be confused.
 *
 * Recording rules:
 *
 * - FAIL-CLOSED ON SCHEMA: every record is validated against the vendored
 *   `effect-ledger-record.schema.json` BEFORE it is appended; a record that
 *   fails is dropped with a warning, never written. A missing vendored
 *   schema suppresses ALL writes (warned once) — the same posture as the
 *   messages.observe envelope check. The schema's `additionalProperties:
 *   false` is what structurally bans secrets from the ledger: callers
 *   cannot smuggle payload fields through.
 * - SEQUENCE: continues across restarts (max sequence in the existing file
 *   + 1); corrupt lines are skipped, never rewritten.
 * - NEVER THROWS: recording is observability, not a gate — internal errors
 *   (including disk failures) are caught and warned, the caller's path is
 *   unaffected.
 *
 * privacyClass: operational — records hold identifiers and error codes,
 * never message content, storage values, or grant-file contents.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { DATA_DIR } from '../utils/paths.js'
import { loadSpecData } from '../plugin-spec/registry.js'
import { check } from '../plugin-spec/schema-check.js'
import { componentIdentityOf } from './component-identity.js'
import { compositionRoot, concreteService } from './host-access.js'

/** Default ledger file (JSONL, one record per line). */
export const EFFECT_LEDGER_FILE = join(DATA_DIR, 'effect-ledger.jsonl')

/** Resource kinds recorded by the host's wired emitters. */
export const LEDGER_RESOURCE_KINDS = [
  'command',
  'scene',
  'shortcut',
  'status',
  'renderer',
  'storage-namespace',
  'subscription',
  'permission',
] as const

export type LedgerOperation = 'create' | 'bind' | 'replace' | 'release' | 'cleanup-failed'
export type LedgerResult = 'applied' | 'pending' | 'failed'

/** Caller-facing record input; the runtime fills the lifecycle triple. */
export interface LedgerEntry {
  operation: LedgerOperation
  resource: { kind: string; id: string }
  result: LedgerResult
  /** Contract error code when result is 'failed' (e.g. PERMISSION_NOT_GRANTED). */
  errorCode?: string
  /** What this record supersedes (operation 'replace'). */
  replaces?: { resourceId?: string; activationInstance?: string }
  /** `sha256:<64hex>` digest of an opaque value, when a record must reference one. */
  valueDigest?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiEffectLedger: TuiEffectLedgerRuntime
  }
}

/** Strip control chars and cap length so a hostile id cannot break the JSONL
 *  line format or blow the schema bounds (JSON.stringify would keep the line
 *  intact, but downstream tooling reads these fields raw). */
function cleanField(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max)
  return cleaned === '' ? fallback : cleaned
}

/** `ctx.tuiEffectLedger` — append-only effect journal (C-060). */
export class TuiEffectLedgerRuntime extends Service {
  constructor(
    ctx: Context,
    options: { file?: string; generationId?: string; ledgerSchema?: Record<string, unknown> } = {},
  ) {
    super(ctx, 'tuiEffectLedger')
    const file = options.file ?? EFFECT_LEDGER_FILE
    // The generation is resolved LAZILY (per first record): cordis does not
    // make sibling services visible to constructors of plugins mounted later
    // by the same apply(), so a constructor-time probe would always miss the
    // plugin-host service and fall back to 'unknown-generation'.
    const state: LedgerState = {
      hostContext: compositionRoot(ctx),
      file,
      optionsGenerationId: options.generationId,
      generationId: undefined,
      activations: new WeakMap(),
      nextActivation: 1,
      sequence: 0,
      schemaWarned: false,
      ledgerSchema: undefined,
    }
    // `'ledgerSchema' in options` lets a caller force-undefined (fail-closed
    // test seam), same contract as the message observer's envelopeSchema.
    state.ledgerSchema = 'ledgerSchema' in options ? options.ledgerSchema : loadSpecData()?.schemas.ledger
    state.sequence = resumeSequence(file)
    ledgerStates.set(this, state)
  }

  /**
   * Append one record. `identity` is the caller's own context (plugins pass
   * their plugin ctx through the managed services' optional trailing
   * parameter); omitting it records `undeclared`, never a guess.
   */
  record(entry: LedgerEntry, identity?: Context): void {
    let state: LedgerState | undefined
    try {
      state = ledgerStateFor(this)
      if (state.ledgerSchema === undefined) {
        if (!state.schemaWarned) {
          state.schemaWarned = true
          state.hostContext.logger.warn('dsh-tui: effect ledger schema unavailable — suppressing all ledger writes (fail-closed)')
        }
        return
      }
      const fiber = this.fiberOf(identity)
      const verified = identity === undefined ? undefined : componentIdentityOf(identity)
      const pluginId = this.pluginIdOf(identity, fiber, verified?.componentId)
      const record = {
        ledgerVersion: '0.15',
        sequence: state.sequence,
        timestamp: new Date().toISOString(),
        pluginId,
        activationInstance: verified?.activationId ?? this.activationOf(fiber, pluginId),
        runtimeGenerationId: this.generation(),
        operation: entry.operation,
        resource: {
          kind: cleanField(entry.resource?.kind, 64, 'unknown'),
          id: cleanField(entry.resource?.id, 128, 'unknown'),
        },
        result: entry.result,
        ...(entry.errorCode !== undefined ? { errorCode: cleanField(entry.errorCode, 64, 'UNKNOWN') } : {}),
        ...(entry.replaces !== undefined
          ? {
              replaces: {
                ...(entry.replaces.resourceId !== undefined
                  ? { resourceId: cleanField(entry.replaces.resourceId, 128, 'unknown') }
                  : {}),
                ...(entry.replaces.activationInstance !== undefined
                  ? { activationInstance: cleanField(entry.replaces.activationInstance, 128, 'unknown') }
                  : {}),
              },
            }
          : {}),
        ...(entry.valueDigest !== undefined ? { valueDigest: entry.valueDigest } : {}),
      }
      // Fail-closed self-check: a record that does not satisfy the vendored
      // schema is DROPPED, not written (the schema's additionalProperties:
      // false is the structural secret ban).
      try {
        check(record, state.ledgerSchema, state.ledgerSchema)
      } catch (error) {
        state.hostContext.logger.warn(
          `dsh-tui: effect ledger record dropped (schema: ${error instanceof Error ? error.message : String(error)})`,
        )
        return
      }
      mkdirSync(dirname(state.file), { recursive: true, mode: 0o700 })
      appendFileSync(state.file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      state.sequence += 1
    } catch (error) {
      ;(state?.hostContext ?? this.ctx).logger.warn('dsh-tui: effect ledger write failed')
    }
  }

  /** Runtime generation (C-050): options override, else the plugin-host
   *  service's id — resolved on first record and cached (the host row mounts
   *  before any caller can record). */
  private generation(): string {
    const state = ledgerStateFor(this)
    if (state.optionsGenerationId !== undefined) return state.optionsGenerationId
    state.generationId ??= state.hostContext.get('tuiPluginHost')?.generationId ?? 'unknown-generation'
    return state.generationId
  }

  /** Continue numbering after the existing file's max sequence (restart-safe). */
  private resumeSequence(): number {
    return resumeSequence(ledgerStateFor(this).file)
  }

  private fiberOf(identity: Context | undefined): object | undefined {
    if (identity === undefined) return undefined
    try {
      const fiber: unknown = identity.fiber
      return typeof fiber === 'object' && fiber !== null ? fiber : undefined
    } catch {
      return undefined
    }
  }

  private pluginIdOf(identity: Context | undefined, fiber: object | undefined, verifiedComponentId?: string): string {
    if (identity === undefined) return 'undeclared'
    if (verifiedComponentId !== undefined) return cleanField(verifiedComponentId, 128, 'undeclared')
    let name = ''
    try {
      name = typeof identity.fiber?.name === 'string' ? identity.fiber.name : ''
    } catch {
      name = ''
    }
    // A non-root fiber without a verified Component is intentionally not
    // attributed by its Cordis export name.  Names are display metadata and
    // can differ from the manifest identity (or be impersonated).
    if (fiber === undefined || name === '' || name === 'root') return 'host'
    return 'undeclared'
  }

  private activationOf(fiber: object | undefined, pluginId: string): string {
    // 'host'/'undeclared' are single-tenant identities (one root fiber per
    // process; 'undeclared' has no fiber at all) — the constant instance id
    // is exact; per-fiber ids only matter for plugin fibers.
    if (fiber === undefined || pluginId === 'host' || pluginId === 'undeclared') return pluginId
    const state = ledgerStateFor(this)
    let activation = state.activations.get(fiber)
    if (activation === undefined) {
      activation = `activation-${state.nextActivation++}`
      state.activations.set(fiber, activation)
    }
    return activation
  }
}

interface LedgerState {
  readonly hostContext: Context
  readonly file: string
  readonly optionsGenerationId: string | undefined
  generationId: string | undefined
  ledgerSchema: Record<string, unknown> | undefined
  readonly activations: WeakMap<object, string>
  nextActivation: number
  sequence: number
  schemaWarned: boolean
}

const ledgerStates = new WeakMap<TuiEffectLedgerRuntime, LedgerState>()

function ledgerStateFor(runtime: TuiEffectLedgerRuntime): LedgerState {
  const state = ledgerStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiEffectLedger host state is unavailable')
  return state
}

/** Continue numbering after the existing file's max sequence (restart-safe). */
function resumeSequence(file: string): number {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 0 // missing file = fresh ledger, not corruption
  }
  let max = -1
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      const sequence = (parsed as { sequence?: unknown }).sequence
      if (typeof sequence === 'number' && Number.isInteger(sequence) && sequence > max) max = sequence
    } catch {
      // Corrupt line: skip it (never rewritten — the bytes stay for manual
      // recovery, same posture as plugin-storage).
    }
  }
  return max + 1
}

export default TuiEffectLedgerRuntime
