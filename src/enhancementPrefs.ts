/** Shared durable preference/sidecar implementation for orthogonal enhancements. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

export interface EnhancementSessionHeader {
  readonly id: unknown
  readonly seedLength?: number
}

export interface EnhancementSessionEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

export interface EnhancementRequestHeader {
  readonly system?: string
  readonly config?: { readonly maxTokens?: number }
  readonly tools?: readonly { readonly name: string }[]
}

const MAX_SESSION_RECORDS = 512

interface EnhancementSessionRecord {
  readonly enabled: boolean
  readonly updatedAt: number
}

interface EnhancementPrefs {
  readonly enabled?: boolean
  readonly sessions: Record<string, EnhancementSessionRecord>
}

export interface EnhancementPrefsDefinition {
  readonly file: string
}

function parse(text: string): EnhancementPrefs {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { sessions: {} }
    const source = value as Record<string, unknown>
    const sessions: Record<string, EnhancementSessionRecord> = {}
    if (source.sessions !== null && typeof source.sessions === 'object' && !Array.isArray(source.sessions)) {
      for (const [id, record] of Object.entries(source.sessions as Record<string, unknown>)) {
        if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
        const candidate = record as Record<string, unknown>
        if (typeof candidate.enabled !== 'boolean' || typeof candidate.updatedAt !== 'number') continue
        sessions[id] = { enabled: candidate.enabled, updatedAt: candidate.updatedAt }
      }
    }
    return {
      ...(typeof source.enabled === 'boolean' ? { enabled: source.enabled } : {}),
      sessions,
    }
  } catch {
    return { sessions: {} }
  }
}

function read(definition: EnhancementPrefsDefinition, dir: string): EnhancementPrefs {
  try {
    return parse(readFileSync(join(dir, definition.file), 'utf8'))
  } catch {
    return { sessions: {} }
  }
}

function write(definition: EnhancementPrefsDefinition, value: EnhancementPrefs, dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, definition.file)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}

export function readEnhancementDefault(
  definition: EnhancementPrefsDefinition,
  dir: string = DATA_DIR,
): boolean | undefined {
  return read(definition, dir).enabled
}

export function writeEnhancementDefault(
  definition: EnhancementPrefsDefinition,
  enabled: boolean,
  dir: string = DATA_DIR,
): boolean {
  const current = read(definition, dir)
  return write(definition, { ...current, enabled }, dir)
}

export function readEnhancementSession(
  definition: EnhancementPrefsDefinition,
  sessionId: string,
  dir: string = DATA_DIR,
): boolean | undefined {
  return read(definition, dir).sessions[sessionId]?.enabled
}

export function writeEnhancementSession(
  definition: EnhancementPrefsDefinition,
  sessionId: string,
  enabled: boolean,
  dir: string = DATA_DIR,
): boolean {
  const current = read(definition, dir)
  const sessions = {
    ...current.sessions,
    [sessionId]: { enabled, updatedAt: Date.now() },
  }
  const retained = Object.fromEntries(
    Object.entries(sessions)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_SESSION_RECORDS),
  )
  return write(definition, { ...current, sessions: retained }, dir)
}

export function enhancementModeOf(
  definition: EnhancementPrefsDefinition,
  session: { header: EnhancementSessionHeader; events: readonly EnhancementSessionEvent[] },
  stored: boolean | undefined = readEnhancementSession(definition, String(session.header.id)),
): boolean {
  // Enhancement state is deliberately kept out of model-visible prompts.
  // The per-session sidecar is the only source of truth.
  return stored ?? false
}

export async function resolvePersistedEnhancement(
  definition: EnhancementPrefsDefinition,
  ctx: { get(name: string): unknown },
  sessionId: string,
): Promise<boolean> {
  const persistence = ctx.get('sessionPersistence') as
    | {
        load(id: string): Promise<{
          meta: EnhancementSessionHeader
          events: readonly EnhancementSessionEvent[]
        }>
      }
    | undefined
  const stored = readEnhancementSession(definition, String(sessionId))
  if (persistence === undefined) return stored ?? false
  try {
    const persisted = await persistence.load(sessionId)
    return enhancementModeOf(definition, { header: persisted.meta, events: persisted.events }, stored)
  } catch {
    return stored ?? false
  }
}
