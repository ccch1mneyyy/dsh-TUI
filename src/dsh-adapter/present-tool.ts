/**
 * The `present` tool's transcript card. `present` declares final deliverables
 * (`{ files: [{ path, description? }] }`) and appends a durable
 * `deliverables/presented` session event, but registers no dsh-tools
 * `presentCall`/`presentResult` presenter — without this local card the
 * transcript dumps the raw argument JSON and a `Presented <path>` text line.
 *
 * The settled result carries the same files as plain text, so both sides read
 * the call arguments: that survives replay from the durable log and needs no
 * deliverable event. The result text also lists the absolute path the tool
 * resolved each file to; matching those lines by position gives relative
 * paths a stable click target and the size/mtime shown next to each name.
 * The result's `meta.cwd` is a fallback for hosts that attach one; a failed
 * stat only drops that metadata. The card is language-neutral on purpose; the
 * card component localizes its count title and formats times at render time.
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
  const absolute = isAbsolute(path) ? path : cwd === undefined ? undefined : resolve(cwd, path)
  // A relative path without the result's cwd cannot be resolved here.
  if (absolute === undefined) return {}
  try {
    const info = statSync(absolute)
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : {}
  } catch {
    return {}
  }
}

/** Validate the declared files; anything malformed contributes nothing. */
function declaredFiles(
  value: unknown,
  cwd: string | undefined,
  resultPaths: readonly string[] | undefined,
): readonly ToolPresentedFile[] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const files: unknown = (value as { files?: unknown }).files
  if (!Array.isArray(files)) return undefined
  // The tool renders one `Presented <absolute>` line per declared file, in
  // call order. Use them only when the result has exactly the same count, so
  // a truncated/foreign result can never shift a path onto the wrong file.
  const targets = resultPaths?.length === files.length ? resultPaths : undefined
  const out: ToolPresentedFile[] = []
  for (let index = 0; index < files.length; index += 1) {
    const entry: unknown = files[index]
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { path?: unknown; description?: unknown }
    if (typeof record.path !== 'string' || record.path.trim() === '') continue
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    const resultTarget = targets?.[index]
    // Prefer the path the tool resolved; otherwise resolve against the
    // result cwd so both the row action and the metadata name one file.
    const target = resultTarget !== undefined && isAbsolute(resultTarget)
      ? resultTarget
      : cwd !== undefined && !isAbsolute(record.path)
        ? resolve(cwd, record.path)
        : undefined
    out.push({
      path: record.path,
      ...(target !== undefined && target !== record.path ? { target } : {}),
      ...(description === '' ? {} : { description }),
      ...fileMeta(target ?? record.path, cwd),
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
 * @param cwd - Session working directory (the result's `meta.cwd`), used as a
 *   fallback to resolve relative paths for size/mtime metadata.
 * @param resultPaths - Absolute paths parsed from the settled result's
 *   `Presented <path>` lines, in call order; used for the click target and
 *   metadata when present.
 */
export function presentToolView(
  name: string,
  rawArgs: string,
  cwd?: string,
  resultPaths?: readonly string[],
): PresentToolView | undefined {
  if (name !== TOOL_NAME) return undefined
  const files = declaredFiles(parseArgs(rawArgs), cwd, resultPaths)
  return files === undefined ? undefined : { card: 'files', files }
}
