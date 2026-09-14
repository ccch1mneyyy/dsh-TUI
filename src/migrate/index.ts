/**
 * Migration registry and import engine.
 *
 * Import writes one DSH session log per foreign conversation, matching the
 * upstream store's on-disk contract exactly: TWO zstd frames (frame 1 = the
 * header line alone, frame 2 = the event lines — the upstream materializer
 * separates them and single-frame logs exceed the TUI's bounded frame
 * reader), file mode 0600 with directories 0700, written via tmp+rename,
 * and SKIPPED when a copy already exists (the deterministic UUIDv5 over
 * `<agent>:<sourceId>` makes re-import land on the same path — skip, not
 * truncate, so a session the TUI has opened for续聊 never gets clobbered).
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { synthesizeSessionEvents } from './synthesize.js'
import type { MigrationAdapter, MigrationSession } from './types.js'
import { migrationUuid } from './uuid.js'
import { claudeCodeAdapter } from './adapters/claude-code.js'
import { codexAdapter } from './adapters/codex.js'
import { ompAdapter } from './adapters/omp.js'

/** Adapters shipped in this build; pi / opencode pending real-world samples. */
export const MIGRATION_ADAPTERS: readonly MigrationAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  ompAdapter,
]

/** Longest single path segment the upstream store's projectKey allows. */
const MUNGE_MAX = 251

/** cwd → the `--dash-munged--` workspace segment DSH sessions use. */
export function mungeCwd(cwd: string): string {
  const body = cwd.replace(/^\/+/u, '').replace(/\/+$/u, '').replace(/[/\\]+/gu, '-')
  const munged = `--${body}--`
  return munged.length <= MUNGE_MAX ? munged : munged.slice(0, MUNGE_MAX)
}

/** What importing one conversation produced. */
export interface ImportOutcome {
  readonly session: MigrationSession
  readonly target: string
  readonly turns: number
  /** False when a copy already existed and was left untouched. */
  readonly wrote: boolean
}

/**
 * Import one conversation into the DSH sessions tree.
 * @param agent - The adapter that produced the session.
 * @param session - The discovered conversation.
 * @param dshHome - Target DSH home (defaults to `$DSH_HOME ?? ~/.dsh`).
 * @returns The outcome, or undefined when the conversation had no user turn.
 */
export function importSession(
  agent: MigrationAdapter,
  session: MigrationSession,
  dshHome: string = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
): ImportOutcome | undefined {
  const sessionId = migrationUuid(`${agent.id}:${session.sourceId}`)
  const events = synthesizeSessionEvents(session, agent.id, sessionId)
  if (events.length === 0) return undefined
  const dir = join(dshHome, 'sessions', mungeCwd(session.cwd), sessionId)
  const target = join(dir, 'session.jsonl.zstd')
  if (existsSync(target)) {
    return { session, target, turns: session.turns.filter(turn => turn.role === 'user').length, wrote: false }
  }
  const [header, ...rest] = events
  if (rest.length === 0) return undefined
  // Two frames, exactly like the upstream materializer: frame 1 = header
  // line, frame 2 = every event line. The TUI's bounded frame reader and the
  // upstream reader both consume concatenated frames.
  const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
  const eventsFrame = zstdCompressSync(Buffer.from(rest.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, Buffer.concat([headerFrame, eventsFrame]), { mode: 0o600 })
  renameSync(tmp, target)
  return { session, target, turns: session.turns.filter(turn => turn.role === 'user').length, wrote: true }
}

export { synthesizeSessionEvents } from './synthesize.js'
export { migrationUuid } from './uuid.js'
export type { MigrationAdapter, MigrationDiscovery, MigrationSession, MigrationTurn } from './types.js'
export type { SynthEvent } from './synthesize.js'
