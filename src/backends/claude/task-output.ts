/**
 * The output tail of a Claude background task (design §4.8 `readOutput`):
 * the CLI writes each task's output to a file it names in its own reports
 * (the backgrounded command's acknowledgement, `task_notification.output_file`);
 * the TUI reads its last bytes, read-only, while the job's card or panel
 * entry is on screen.
 *
 * The path comes from the CLI's report — model-influenced text — so it is
 * validated before anything is opened: an absolute path whose file name is
 * `<taskId>.output`, which after resolving every symlink still lies inside
 * the CLI's own directories (the system temp directory the CLI keeps task
 * output in, `/tmp` on POSIX, or the Claude config directory), and which is
 * a regular file opened without following a final symlink (and without
 * blocking: a FIFO in its place is refused, not waited on). Only the last
 * {@link TASK_OUTPUT_TAIL_BYTES} are read.
 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { t } from '../../i18n.js'

/** The tail read per call (the card shows 3 lines, the panel 30). */
export const TASK_OUTPUT_TAIL_BYTES = 64 * 1024

/** Where the CLI may keep task output (each resolved, symlinks included). */
export function taskOutputRoots(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const candidates = [
    tmpdir(),
    ...(process.platform === 'win32' ? [] : ['/tmp']),
    env.CLAUDE_CODE_TMPDIR,
    env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  ]
  const roots: string[] = []
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    try {
      const real = realpathSync(candidate)
      if (!roots.includes(real)) roots.push(real)
    } catch {
      // A root that does not exist holds nothing.
    }
  }
  return roots
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * Validate a reported output path for one task; returns the resolved path
 * or throws a user-facing error (never opening anything that fails).
 */
export function resolveTaskOutputPath(reported: string, taskId: string, roots: readonly string[]): string {
  if (!isAbsolute(reported) || basename(reported) !== `${taskId}.output` || /[\0]/u.test(reported)) {
    throw new Error(t('claude-task-output-refused', { id: taskId }))
  }
  let real: string
  try {
    real = realpathSync(reported)
  } catch {
    throw new Error(t('claude-task-output-missing', { id: taskId }))
  }
  if (!roots.some(root => inside(root, real))) throw new Error(t('claude-task-output-refused', { id: taskId }))
  return real
}

/** The last {@link TASK_OUTPUT_TAIL_BYTES} of a task's output (a partial
 *  first line dropped when the read starts mid-file). */
export function readTaskOutputTail(reported: string, taskId: string, roots: readonly string[] = taskOutputRoots()): string {
  const path = resolveTaskOutputPath(reported, taskId, roots)
  // O_NONBLOCK (POSIX): a FIFO named like the output file must not park this
  // synchronous open — the UI thread — until a writer appears; it opens at
  // once and the regular-file check below refuses it. A regular file ignores
  // the flag.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(t('claude-task-output-refused', { id: taskId }))
    const length = Math.min(stat.size, TASK_OUTPUT_TAIL_BYTES)
    const start = stat.size - length
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n === 0) break
      read += n
    }
    const text = buffer.subarray(0, read).toString('utf8')
    if (start === 0) return text
    const newline = text.indexOf('\n')
    return newline === -1 ? '' : text.slice(newline + 1)
  } finally {
    closeSync(fd)
  }
}
