/**
 * Reading the persistence header — total functions over foreign data.
 *
 * `sessionPersistence.list()` is a service resolved from the running context,
 * so its results are foreign values that happen to be typed. Every accessor
 * here therefore narrows structurally and returns a fallback rather than
 * throwing: one malformed header must cost that session its metadata, never
 * the whole listing. This mirrors the discipline the trajectory guards already
 * apply to session events.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/header
 */
import type { SessionKind } from './types.js'

/** The header fields this feature reads, all optional at runtime. */
export interface RawSessionHeader {
  readonly id: string
  readonly cwd: string | undefined
  readonly createdAt: number | undefined
  readonly parentSession: string | undefined
  readonly origin: string | undefined
  readonly delegationDepth: number | undefined
  readonly seedLength: number | undefined
  readonly agentPreset: string | undefined
}

/** A finite number, or undefined for anything else (NaN and ±Infinity included). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Narrow one listed header.
 *
 * @param value - A header as the persistence service returned it.
 * @returns The fields this feature uses, or undefined when the value carries
 *   no usable session id — the one field nothing can substitute for.
 */
export function readHeader(value: unknown): RawSessionHeader | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = text(record['id'])
  if (id === undefined) return undefined
  return {
    id,
    cwd: text(record['cwd']),
    createdAt: finiteNumber(record['createdAt']),
    parentSession: text(record['parentSession']),
    origin: text(record['origin']),
    delegationDepth: finiteNumber(record['delegationDepth']),
    seedLength: readInheritedCut(record),
    agentPreset: text(record['agentPreset']),
  }
}

/**
 * Exact inherited prefix length from a persistence record. Accepts physical
 * `seedLength` or inspect `inheritedEventCount`. Never infers 0 from
 * `isSeeded`, snapshot length, or `session/end-seed`.
 */
export function readInheritedCut(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const seedLength = finiteNumber(record['seedLength'])
  if (
    seedLength !== undefined &&
    Number.isSafeInteger(seedLength) &&
    seedLength >= 0 &&
    !Object.is(seedLength, -0)
  ) return seedLength
  const inherited = finiteNumber(record['inheritedEventCount'])
  if (
    inherited !== undefined &&
    Number.isSafeInteger(inherited) &&
    inherited >= 0 &&
    !Object.is(inherited, -0)
  ) return inherited
  return undefined
}

/**
 * Decide what a session is, from its header alone.
 *
 * Precedence is `origin` first, lineage second, and that order is the whole
 * correctness argument: a `/rewind` fork records `parentSession` exactly like
 * a delegated run does, and only `origin` separates them. Upstream documents
 * `origin` as "coarse product classification for a session created as a
 * subagent child … presentation metadata", which is precisely this decision.
 *
 * `delegationDepth` is optional upstream, so a sub-agent whose header omits it
 * is reported at depth 1: it is a delegated child by `origin`, and 1 is the
 * shallowest depth that can be.
 *
 * @param header - A narrowed header.
 * @returns The session's kind.
 */
export function classify(header: RawSessionHeader): SessionKind {
  if (header.origin === 'subagent') {
    return {
      kind: 'subagent',
      parent: header.parentSession,
      depth: header.delegationDepth ?? 1,
    }
  }
  if (header.parentSession !== undefined) {
    return { kind: 'fork', parent: header.parentSession }
  }
  return { kind: 'root' }
}
