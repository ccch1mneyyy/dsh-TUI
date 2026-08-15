/**
 * Patch-surface contract: the TUI profile patch may only touch official
 * rows that are justified. The baseline for "justified" is a SNAPSHOT
 * (patch-surface.snapshot.json) derived from:
 *
 *   1. rows the official @deepseek-ai/dsh-web-app patch also disables —
 *      preset-ownership transition rows, required for any preset-based
 *      composition (web included), NOT TUI-specific coupling;
 *   2. rows the TUI genuinely owns (inserts + its own config overrides).
 *
 * The verifier recomputes the live surface from the installed packages and
 * diffs it against the snapshot. When upstream adds/removes rows, the diff
 * fails HERE (CI) instead of silently drifting on user machines; reviewing
 * the diff and regenerating the snapshot is the documented upgrade step.
 *
 * Run via `node --import tsx/esm scripts/verify-patch-surface.ts`.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const tuiPatchPath = join(root, 'cordis.patch.yml')
const snapshotPath = join(root, 'patch-surface.snapshot.json')

interface ParsedPatch {
  /** Top-level rows with id and optional disabled/config. */
  overrides: Array<{ id: string; disabled: boolean; hasConfig: boolean }>
  /** Rows listed inside `- insert:` blocks. */
  inserts: Array<{ id: string }>
}

function parsePatch(text: string): ParsedPatch {
  const doc = parseYaml(text) as unknown
  const overrides: ParsedPatch['overrides'] = []
  const inserts: ParsedPatch['inserts'] = []
  if (!Array.isArray(doc)) throw new Error('patch root is not a list')
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      for (const row of record.insert) {
        if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string') {
          inserts.push({ id: (row as Record<string, unknown>).id as string })
        }
      }
      continue
    }
    if (typeof record.id === 'string') {
      overrides.push({
        id: record.id,
        disabled: record.disabled === true,
        hasConfig: 'config' in record,
      })
    }
  }
  return { overrides, inserts }
}

function readInstalledPatch(packageName: string): string {
  const path = import.meta.resolve(`${packageName}/cordis.patch.yml`)
  return readFileSync(path.startsWith('file:') ? fileURLToPath(path) : path, 'utf8')
}

if (!existsSync(tuiPatchPath)) {
  console.error('cordis.patch.yml missing')
  process.exit(1)
}
const tui = parsePatch(readFileSync(tuiPatchPath, 'utf8'))

let webAppPatch = ''
try {
  webAppPatch = readInstalledPatch('@deepseek-ai/dsh-web-app')
} catch {
  console.warn('@deepseek-ai/dsh-web-app not installed — skipping web-app patch comparison')
}
const webAppAvailable = webAppPatch !== ''
const webApp = webAppAvailable ? parsePatch(webAppPatch) : { overrides: [], inserts: [] }

const tuiDisableSet = new Set(tui.overrides.filter(r => r.disabled).map(r => r.id))
const webAppDisableSet = new Set(webApp.overrides.filter(r => r.disabled).map(r => r.id))
const webAppInsertSet = new Set(webApp.inserts.map(r => r.id))

interface Snapshot {
  inserts: string[]
  configOverrides: string[]
  /** Rows the TUI disables that the official web-app patch does NOT. */
  disablesBeyondWebApp: string[]
  /** Rows the official web-app patch disables that the TUI does NOT. */
  webAppDisablesBeyondTui: string[]
  /** Rows the TUI inserts that the official web-app patch also inserts. */
  insertsSharedWithWebApp: string[]
}

const computed: Snapshot = {
  inserts: tui.inserts.map(r => r.id),
  configOverrides: tui.overrides.filter(r => !r.disabled && r.hasConfig).map(r => r.id),
  disablesBeyondWebApp: tui.overrides.filter(r => r.disabled && !webAppDisableSet.has(r.id)).map(r => r.id),
  webAppDisablesBeyondTui: webApp.overrides.filter(r => r.disabled && !tuiDisableSet.has(r.id)).map(r => r.id),
  insertsSharedWithWebApp: tui.inserts.filter(r => webAppInsertSet.has(r.id)).map(r => r.id),
}

const mode = process.argv[2]
if (mode === '--snapshot') {
  if (!webAppAvailable) {
    // A snapshot taken without the web-app baseline records every shared row
    // as TUI-specific drift and poisons every later comparison.
    console.error('refusing to snapshot without @deepseek-ai/dsh-web-app installed (baseline would be empty)')
    process.exit(1)
  }
  writeFileSync(snapshotPath, `${JSON.stringify(computed, null, 2)}\n`)
  console.log(`patch-surface snapshot written: ${snapshotPath}`)
  process.exit(0)
}

if (!existsSync(snapshotPath)) {
  console.error('patch-surface.snapshot.json missing — run: node --import tsx/esm scripts/verify-patch-surface.ts --snapshot')
  process.exit(1)
}
const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot
// The three webApp-derived fields are only comparable when the baseline
// package is installed; the TUI-own fields always are.
const same = webAppAvailable
  ? JSON.stringify(recorded) === JSON.stringify(computed)
  : JSON.stringify(recorded.inserts) === JSON.stringify(computed.inserts) &&
    JSON.stringify(recorded.configOverrides) === JSON.stringify(computed.configOverrides)
if (same) {
  console.log(
    `patch-surface OK (${computed.inserts.length} inserts, ` +
    `${computed.configOverrides.length} config overrides, ` +
    `${computed.disablesBeyondWebApp.length} disables beyond web-app)`,
  )
  process.exit(0)
}
console.error('patch-surface drifted from snapshot:')
console.error('  recorded:', JSON.stringify(recorded))
console.error('  current :', JSON.stringify(computed))
console.error('Review the diff, then regenerate: node --import tsx/esm scripts/verify-patch-surface.ts --snapshot')
process.exit(1)
