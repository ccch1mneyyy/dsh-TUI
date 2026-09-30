/**
 * Codex adapter: `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`. File
 * discovery lives here; the rollout format is parsed by the pure
 * codex.parse.ts. The browse scan runs the same parser over the rollout's
 * head: the first session_meta, the first real prompt and the sub-agent
 * marker all sit there.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/codex
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ForeignSessionSummary, LoadSkip, MigrationAdapter, MigrationDiscovery, MigrationSession, ScanOptions, WalkSpec } from '../types.js'
import { parseCodexRollout } from './codex.parse.js'
import { countEntries } from './scan.js'
import { fingerprintOf, loadText, runScan, walkFiles, withHead, type ScanCandidate } from './scan-fs.js'

const isRollout = (name: string): boolean => name.startsWith('rollout-') && name.endsWith('.jsonl')

const WALK: WalkSpec = { maxDepth: 5, match: isRollout }

/** The rollout's stable source id: the uuid in its file name. */
function sourceIdOf(path: string): string {
  const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(path)
  // Fallback is the bare file name, never the whole path: the id is the dedupe
  // key, so an absolute path would make it depend on where the store lives.
  return match?.[1] ?? basename(path)
}

function readOne(path: string): MigrationSession | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  return parseCodexRollout({ raw, sourceId: sourceIdOf(path) })
}

async function summarize({ ref, fp }: ScanCandidate): Promise<ForeignSessionSummary | null> {
  const session = await withHead(ref, fp.size, raw => parseCodexRollout({ raw, sourceId: sourceIdOf(ref) }))
  if (session === undefined) return null
  return {
    agentId: 'codex',
    sessionKey: session.sourceId,
    ref,
    title: session.title ?? '',
    cwd: session.cwd,
    lastMessageAt: fp.mtimeMs,
    createdAt: session.startedAt || fp.mtimeMs,
  }
}

export const codexAdapter: MigrationAdapter = {
  id: 'codex',
  label: 'Codex',
  roots: () => [join(homedir(), '.codex', 'sessions')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && isRollout(entry.name)) {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(path)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0)
    return { roots, sessions }
  },
  count(): number {
    return countEntries(this.roots(), { maxDepth: WALK.maxDepth, fileMatch: WALK.match })
  },
  walk: WALK,
  async scan(options?: ScanOptions) {
    const files = walkFiles(this.roots(), { ...WALK, signal: options?.signal })
    return runScan(files, file => file.path, fingerprintOf, options, summarize)
  },
  async load(ref: string): Promise<MigrationSession | LoadSkip> {
    const raw = await loadText(ref)
    if (typeof raw !== 'string') return raw
    return parseCodexRollout({ raw, sourceId: sourceIdOf(ref) }) ?? { skip: 'not-a-session' }
  },
}
