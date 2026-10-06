/**
 * Paths as tool cards and prompts show them (shared by every backend, D15):
 * relative to the session cwd when inside it, else as given.
 */
import { isAbsolute, relative } from 'node:path'

/** A path for a title: relative to the session cwd when inside it. */
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path) || cwd === '') return path
  const rel = relative(cwd, path)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel
}
