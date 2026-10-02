/**
 * Session-catalog benchmark (docs/agent-backend-design.md §4.11, §8.5 Gate):
 * how long the SDK's `listSessions` takes over synthetic Claude config trees
 * of 0 / 10 / 100 / 500 sessions, for one project (`{dir}`) and for every
 * project (no `dir`), cold (the first call of a fresh process) and warm (the
 * median of the next calls). Gate: 500 sessions ≤ 300 ms warm for the
 * project listing the browser paints first.
 *
 * The trees are built from one committed redacted transcript
 * (`scripts/fixtures/claude/disk/bench-transcript.jsonl`): each copy gets its own
 * session id, timestamps and mtime; 4 of 5 copies live in the measured
 * project, the rest in 9 other projects (the all-projects view reads them
 * all). `CLAUDE_CONFIG_DIR` points the SDK at the tree; nothing touches the
 * user's `~/.claude`. No CLI runs, no model is called.
 *
 * Run: node --import tsx/esm scripts/bench-claude-sessions.ts [--json]
 * (each size measures in a child process so "cold" is a fresh import).
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZES = [0, 10, 100, 500] as const
const GATE_MS = 300
const WARM_RUNS = 7
const FIXTURE = fileURLToPath(new URL('./fixtures/claude/disk/bench-transcript.jsonl', import.meta.url))
/** The fixture's placeholders (redacted ids and paths). */
const FIXTURE_SESSION = '00000000-0000-4000-8000-000000000001'
const FIXTURE_CWD = '/fixture/project'

/** The CLI's project-directory name for a cwd (non-alphanumerics → `-`). */
const munge = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/gu, '-')

interface Measure { readonly coldMs: number; readonly warmMs: number; readonly count: number }

/** Child mode: measure one tree. */
async function child(): Promise<void> {
  const [scope, project] = process.argv.slice(3)
  const { listSessions } = await import('@anthropic-ai/claude-agent-sdk')
  const run = async (): Promise<{ ms: number; count: number }> => {
    const start = performance.now()
    const rows = scope === 'all' ? await listSessions({ includeProgrammatic: true }) : await listSessions({ dir: project!, includeProgrammatic: true })
    return { ms: performance.now() - start, count: rows.length }
  }
  const cold = await run()
  const warm: number[] = []
  for (let i = 0; i < WARM_RUNS; i += 1) warm.push((await run()).ms)
  warm.sort((a, b) => a - b)
  const result: Measure = { coldMs: cold.ms, warmMs: warm[Math.floor(warm.length / 2)]!, count: cold.count }
  process.stdout.write(JSON.stringify(result))
}

/** Build a config tree with `n` sessions; returns the measured project cwd. */
function buildTree(root: string, n: number): string {
  const template = readFileSync(FIXTURE, 'utf8')
  const project = join(root, 'work', 'bench-project')
  mkdirSync(project, { recursive: true })
  const now = Date.now()
  for (let i = 0; i < n; i += 1) {
    const cwd = i % 5 === 4 ? join(root, 'work', `other-${i % 9}`) : project
    mkdirSync(cwd, { recursive: true })
    const dir = join(root, 'config', 'projects', munge(cwd))
    mkdirSync(dir, { recursive: true })
    const id = randomUUID()
    const stamp = new Date(now - i * 60_000).toISOString()
    const text = template
      .split(FIXTURE_SESSION).join(id)
      .split(FIXTURE_CWD).join(cwd)
      .replace(/"timestamp":"[^"]*"/gu, `"timestamp":"${stamp}"`)
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, text)
    const mtime = new Date(now - i * 60_000)
    utimesSync(file, mtime, mtime)
  }
  mkdirSync(join(root, 'config', 'projects'), { recursive: true })
  return project
}

async function main(): Promise<void> {
  if (process.argv[2] === '--child') return child()
  const json = process.argv.includes('--json')
  const results: Record<string, { project: Measure; all: Measure }> = {}
  for (const size of SIZES) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-bench-claude-'))
    try {
      const project = buildTree(root, size)
      const measure = (scope: 'dir' | 'all'): Measure => JSON.parse(execFileSync(process.execPath, [
        '--import', 'tsx/esm', fileURLToPath(import.meta.url), '--child', scope, project,
      ], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'config') }, encoding: 'utf8' })) as Measure
      results[size] = { project: measure('dir'), all: measure('all') }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  } else {
    console.log('sessions | project rows  cold ms  warm ms | all rows  cold ms  warm ms')
    for (const size of SIZES) {
      const { project, all } = results[size]!
      console.log(`${String(size).padStart(8)} | ${String(project.count).padStart(12)} ${project.coldMs.toFixed(1).padStart(8)} ${project.warmMs.toFixed(1).padStart(8)} | ${String(all.count).padStart(8)} ${all.coldMs.toFixed(1).padStart(8)} ${all.warmMs.toFixed(1).padStart(8)}`)
    }
  }
  const gate = results[500]!
  const ok = gate.project.warmMs <= GATE_MS
  console.log(`${ok ? 'PASS' : 'FAIL'} gate: 500 sessions, project listing warm ${gate.project.warmMs.toFixed(1)} ms ≤ ${GATE_MS} ms (all projects warm ${gate.all.warmMs.toFixed(1)} ms)`)
  // Rows must be what was built (a tree the SDK cannot read would be "fast").
  const counted = SIZES.every(size => results[size]!.all.count === size && results[size]!.project.count === size - Math.floor((size + 0) / 5))
  if (!counted) console.log(`FAIL rows: ${JSON.stringify(SIZES.map(size => [size, results[size]!.project.count, results[size]!.all.count]))}`)
  process.exit(ok && counted ? 0 : 1)
}

await main()
