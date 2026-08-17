/**
 * Effect ledger (C-060): an append-only JSONL journal of plugin-visible
 * effects at `~/.dsh-tui/effect-ledger.jsonl`, mounted by the
 * dsh-tui-plugin-host row as `ctx.tuiEffectLedger`.
 *
 * Every record carries the lifecycle triple:
 *
 * - `pluginId` — derived from the PASSED identity context's `fiber.name`
 *   (the same honest-identity rule as storage.local: there is no parameter
 *   to impersonate another plugin). `'host'` when the host itself records
 *   (root fiber), `'undeclared'` when a plugin-facing method was called
 *   without the optional `identity` argument.
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
  private readonly file: string
  private readonly optionsGenerationId: string | undefined
  private generationId: string | undefined
  private readonly ledgerSchema: Record<string, unknown> | undefined
  private readonly activations = new WeakMap<object, string>()
  private nextActivation = 1
  private sequence: number
  private schemaWarned = false

  constructor(
    ctx: Context,
    options: { file?: string; generationId?: string; ledgerSchema?: Record<string, unknown> } = {},
  ) {
    super(ctx, 'tuiEffectLedger')
    this.file = options.file ?? EFFECT_LEDGER_FILE
    // The generation is resolved LAZILY (per first record): cordis does not
    // make sibling services visible to constructors of plugins mounted later
    // by the same apply(), so a constructor-time probe would always miss the
    // plugin-host service and fall back to 'unknown-generation'.
    this.optionsGenerationId = options.generationId
    // `'ledgerSchema' in options` lets a caller force-undefined (fail-closed
    // test seam), same contract as the message observer's envelopeSchema.
    this.ledgerSchema = 'ledgerSchema' in options ? options.ledgerSchema : loadSpecData()?.schemas.ledger
    this.sequence = this.resumeSequence()
  }

  /**
   * Append one record. `identity` is the caller's own context (plugins pass
   * their plugin ctx through the managed services' optional trailing
   * parameter); omitting it records `undeclared`, never a guess.
   */
  record(entry: LedgerEntry, identity?: Context): void {
    try {
      if (this.ledgerSchema === undefined) {
        if (!this.schemaWarned) {
          this.schemaWarned = true
          this.ctx.logger.warn('dsh-tui: effect ledger schema unavailable — suppressing all ledger writes (fail-closed)')
        }
        return
      }
      const fiber = this.fiberOf(identity)
      const pluginId = this.pluginIdOf(identity, fiber)
      const record = {
        ledgerVersion: '0.15',
        sequence: this.sequence,
        timestamp: new Date().toISOString(),
        pluginId,
        activationInstance: this.activationOf(fiber, pluginId),
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
        check(record, this.ledgerSchema, this.ledgerSchema)
      } catch (error) {
        this.ctx.logger.warn(
          `dsh-tui: effect ledger record dropped (schema: ${error instanceof Error ? error.message : String(error)})`,
        )
        return
      }
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      this.sequence += 1
    } catch (error) {
      this.ctx.logger.warn(`dsh-tui: effect ledger write failed: %o`, error)
    }
  }

  /** Runtime generation (C-050): options override, else the plugin-host
   *  service's id — resolved on first record and cached (the host row mounts
   *  before any caller can record). */
  private generation(): string {
    if (this.optionsGenerationId !== undefined) return this.optionsGenerationId
    this.generationId ??= this.ctx.get('tuiPluginHost')?.generationId ?? 'unknown-generation'
    return this.generationId
  }

  /** Continue numbering after the existing file's max sequence (restart-safe). */
  private resumeSequence(): number {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
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

  private fiberOf(identity: Context | undefined): object | undefined {
    if (identity === undefined) return undefined
    try {
      const fiber: unknown = identity.fiber
      return typeof fiber === 'object' && fiber !== null ? fiber : undefined
    } catch {
      return undefined
    }
  }

  private pluginIdOf(identity: Context | undefined, fiber: object | undefined): string {
    if (identity === undefined) return 'undeclared'
    let name = ''
    try {
      name = typeof identity.fiber?.name === 'string' ? identity.fiber.name : ''
    } catch {
      name = ''
    }
    if (fiber === undefined || name === '' || name === 'root') return 'host'
    return cleanField(name, 128, 'host')
  }

  private activationOf(fiber: object | undefined, pluginId: string): string {
    // 'host'/'undeclared' are single-tenant identities (one root fiber per
    // process; 'undeclared' has no fiber at all) — the constant instance id
    // is exact; per-fiber ids only matter for plugin fibers.
    if (fiber === undefined || pluginId === 'host' || pluginId === 'undeclared') return pluginId
    let activation = this.activations.get(fiber)
    if (activation === undefined) {
      activation = `activation-${this.nextActivation++}`
      this.activations.set(fiber, activation)
    }
    return activation
  }
}

export default TuiEffectLedgerRuntime
