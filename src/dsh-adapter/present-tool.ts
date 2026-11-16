/**
 * The `present` tool's transcript card. `present` declares final deliverables
 * (`{ files: [{ path, description? }] }`) and appends a durable
 * `deliverables/presented` session event, but registers no dsh-tools
 * `presentCall`/`presentResult` presenter — without this local card the
 * transcript dumps the raw argument JSON and a `Presented <path>` text line.
 *
 * The settled result carries the same files as plain text, so both sides read
 * the call arguments: that survives replay from the durable log and needs no
 * deliverable event. The tool result's `meta.cwd` resolves relative paths for
 * the size/mtime shown next to each name; a failed stat only drops that
 * metadata. The card is language-neutral on purpose; the card component
 * localizes its count title and formats times at render time.
 */
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ToolPresentedFile } from '../adapter/ports/channel-view.js'

/** The `present` card shape; assignable to both call and result unions. */
export interface PresentToolView {
  readonly card: 'files'
  readonly files: readonly ToolPresentedFile[]
}

const TOOL_NAME = 'present'

function parseArgs(rawArgs: string): unknown {
  try {
    return JSON.parse(rawArgs) as unknown
  } catch {
    return undefined
  }
}

/** Size/mtime when the path resolves and still names a regular file. */
function fileMeta(path: string, cwd: string | undefined): Pick<ToolPresentedFile, 'size' | 'mtimeMs'> {
  const absolute = cwd !== undefined && !isAbsolute(path) ? resolve(cwd, path) : path
  // A relative path without the result's cwd cannot be resolved here.
  if (!isAbsolute(absolute)) return {}
  try {
    const info = statSync(absolute)
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : {}
  } catch {
    return {}
  }
}

/** Validate the declared files; anything malformed contributes nothing. */
function declaredFiles(value: unknown, cwd: string | undefined): readonly ToolPresentedFile[] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const files: unknown = (value as { files?: unknown }).files
  if (!Array.isArray(files)) return undefined
  const out: ToolPresentedFile[] = []
  for (const entry of files) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { path?: unknown; description?: unknown }
    if (typeof record.path !== 'string' || record.path.trim() === '') continue
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    out.push({
      path: record.path,
      ...(description === '' ? {} : { description }),
      ...fileMeta(record.path, cwd),
    })
  }
  return out.length === 0 ? undefined : out
}

/**
 * Render `present` as its delivery card. Returns undefined for any other tool
 * or an argument set without files, so the registry/raw-text path still owns
 * everything else.
 * @param name - Model-facing tool name.
 * @param rawArgs - The call's raw JSON arguments.
 * @param cwd - Session working directory (the result's `meta.cwd`), used to
 *   resolve relative paths for the size/mtime metadata.
 */
export function presentToolView(name: string, rawArgs: string, cwd?: string): PresentToolView | undefined {
  if (name !== TOOL_NAME) return undefined
  const files = declaredFiles(parseArgs(rawArgs), cwd)
  return files === undefined ? undefined : { card: 'files', files }
}
