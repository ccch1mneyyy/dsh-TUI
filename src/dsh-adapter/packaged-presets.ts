import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = '@deepseek-harness-tui/dsh-tui'
const MARKER = '.dsh-tui-managed.json'

interface ManagedMarker {
  owner: string
  preset: string
  revision: string
}

export interface PackagedPresetResult {
  id: string
  status: 'installed' | 'updated' | 'current' | 'conflict'
}

export interface PackagedPresetOptions {
  dshHome?: string
  sourceRoot?: string
  moduleUrl?: string
}

function readMarker(directory: string): ManagedMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, MARKER), 'utf8')) as Partial<ManagedMarker>
    if (
      value.owner === OWNER
      && typeof value.preset === 'string'
      && typeof value.revision === 'string'
      && value.revision.length > 0
    ) {
      return value as ManagedMarker
    }
  } catch {
    // An absent or user-authored marker means this directory is not ours.
  }
  return undefined
}

/** Resolve the package asset in both src/tsx and compiled npm layouts. */
export function packagedPresetRoot(moduleUrl: string = import.meta.url): string {
  const directory = dirname(fileURLToPath(moduleUrl))
  const candidates = [join(directory, '../../presets'), join(directory, '../../../presets')]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`dsh-tui: packaged preset root is missing (checked ${candidates.join(', ')})`)
  }
  return found
}

/**
 * Materialize presets shipped by dsh-tui into the Harness user preset root.
 *
 * The official launcher replaces the roster's configured roots with its own
 * shipped root at the end of profile composition, so a bundle patch cannot
 * add a second system root. The user root is the roster's supported extension
 * seam and is discovered on every list/resolve call. Existing unmarked
 * directories are never overwritten.
 */
export function ensurePackagedPresets(options: PackagedPresetOptions = {}): PackagedPresetResult[] {
  const sourceRoot = options.sourceRoot ?? packagedPresetRoot(options.moduleUrl)
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const targetRoot = join(dshHome, '.agent-presets')
  const results: PackagedPresetResult[] = []

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    const source = join(sourceRoot, id)
    const sourceMarker = readMarker(source)
    if (sourceMarker === undefined || sourceMarker.preset !== id) {
      throw new Error(`dsh-tui: packaged preset ${id} has no valid ${MARKER}`)
    }

    const target = join(targetRoot, id)
    if (!existsSync(target)) {
      mkdirSync(targetRoot, { recursive: true })
      // `filter` forces the JS copy path (see src/utils/paths.ts): the native
      // cpSync fast path fails with EIO or crashes under a non-ASCII home
      // directory such as `C:\Users\米`.
      cpSync(source, target, { recursive: true, force: false, errorOnExist: true, filter: () => true })
      results.push({ id, status: 'installed' })
      continue
    }

    const targetMarker = readMarker(target)
    if (targetMarker === undefined || targetMarker.preset !== id) {
      results.push({ id, status: 'conflict' })
      continue
    }
    if (targetMarker.revision === sourceMarker.revision) {
      results.push({ id, status: 'current' })
      continue
    }

    const suffix = `${process.pid}-${randomUUID()}`
    const staged = join(targetRoot, `.${id}.staged-${suffix}`)
    const backup = join(targetRoot, `.${id}.backup-${suffix}`)
    cpSync(source, staged, { recursive: true, force: false, errorOnExist: true, filter: () => true })
    try {
      renameSync(target, backup)
      renameSync(staged, target)
      rmSync(backup, { recursive: true, force: true })
    } catch (error) {
      if (!existsSync(target) && existsSync(backup)) renameSync(backup, target)
      rmSync(staged, { recursive: true, force: true })
      throw error
    }
    results.push({ id, status: 'updated' })
  }

  return results
}
