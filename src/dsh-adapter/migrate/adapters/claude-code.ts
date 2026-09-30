/**
 * Claude Code adapter: `~/.claude/projects/<munged-cwd>/<session>.jsonl`.
 * File discovery lives here; the line format is parsed by the pure
 * claude-code.parse.ts. The browse scan derives each summary from the same
 * parser run over the file's head, plus a tail window for the /rename title
 * (renames append, the last one wins).
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/claude-code
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseJsonl } from '../parse/jsonl.js'
import { normalizeTitle } from '../parse/title.js'
import type { ForeignSessionSummary, LoadSkip, MigrationAdapter, MigrationDiscovery, MigrationSession, ScanOptions, WalkSpec } from '../types.js'
import { parseClaudeTranscript } from './claude-code.parse.js'
import { countEntries } from './scan.js'
import { fingerprintOf, loadText, readTail, runScan, walkFiles, withHead, type ScanCandidate } from './scan-fs.js'

/** Sub-agent transcripts (`<session>/subagents/*.jsonl`) belong to their
 *  parent session; they are never conversations of their own. */
const SUBAGENT_DIR = 'subagents'

const WALK: WalkSpec = { maxDepth: 3, match: name => name.endsWith('.jsonl'), skipDirs: [SUBAGENT_DIR] }

/** Tail window searched for the latest /rename title. */
const TITLE_TAIL_BYTES = 64 * 1024

/** File name without `.jsonl`: the session's stable source id. */
const fileStemOf = (path: string): string => basename(path).replace(/\.jsonl$/u, '')

/** cwd guessed from the project directory name, for logs whose lines record none. */
const fallbackCwdOf = (path: string): string => unmunge(basename(dirname(path))) ?? homedir()

/** The last /rename title in a tail window, when there is one. */
function tailRenameTitle(tail: string): string | undefined {
  let title: string | undefined
  for (const record of parseJsonl(tail).records) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim() !== '') title = record.customTitle
  }
  return title
}

async function summarize({ ref, fp }: ScanCandidate): Promise<ForeignSessionSummary | null> {
  const input = { fileStem: fileStemOf(ref), fallbackCwd: fallbackCwdOf(ref) }
  const found = await withHead(ref, fp.size, (raw, whole) => {
    const session = parseClaudeTranscript({ ...input, raw })
    return session === undefined ? undefined : { session, whole }
  })
  if (found === undefined) return null
  const { session, whole } = found
  const renamed = whole ? undefined : tailRenameTitle(await readTail(ref, TITLE_TAIL_BYTES, fp.size))
  return {
    agentId: 'claude-code',
    sessionKey: session.sourceId,
    ref,
    title: renamed === undefined ? session.title ?? '' : normalizeTitle(renamed),
    cwd: session.cwd,
    lastMessageAt: fp.mtimeMs,
    createdAt: session.startedAt || fp.mtimeMs,
  }
}

function readOne(path: string, fallbackCwd: string): MigrationSession | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  // basename(), not split('/'): join() produces `\` separators on Windows, so
  // splitting on '/' would leave the WHOLE absolute path as the id — and the
  // id is the dedupe key (moving the source store would re-import everything).
  return parseClaudeTranscript({ raw, fileStem: fileStemOf(path), fallbackCwd })
}

export const claudeCodeAdapter: MigrationAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  roots: () => [join(homedir(), '.claude', 'projects')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number, fallbackCwd: string): void => {
      if (depth > 3) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== SUBAGENT_DIR) walk(path, depth + 1, unmunge(entry.name) ?? fallbackCwd)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(path, fallbackCwd)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0, homedir())
    return { roots, sessions }
  },
  count(): number {
    return countEntries(this.roots(), { maxDepth: WALK.maxDepth, fileMatch: WALK.match, skipDirs: WALK.skipDirs })
  },
  walk: WALK,
  async scan(options?: ScanOptions) {
    const files = walkFiles(this.roots(), { ...WALK, signal: options?.signal })
    return runScan(files, file => file.path, fingerprintOf, options, summarize)
  },
  async load(ref: string): Promise<MigrationSession | LoadSkip> {
    const raw = await loadText(ref)
    if (typeof raw !== 'string') return raw
    return parseClaudeTranscript({ raw, fileStem: fileStemOf(ref), fallbackCwd: fallbackCwdOf(ref) }) ?? { skip: 'not-a-session' }
  },
}

/** Best-effort inverse of Claude Code's dash-munged directory names. */
function unmunge(name: string): string | undefined {
  if (!name.startsWith('-')) return undefined
  return `/${name.split('-').filter(Boolean).join('/')}`
}
