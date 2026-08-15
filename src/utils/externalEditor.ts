/**
 * External editor round-trip for the prompt input (issue #123): Ctrl+X dumps
 * the current draft into a temp file, hands the terminal to `$VISUAL` /
 * `$EDITOR` (nvim, vim, nano, `code --wait`, …), and returns the saved text
 * for the input to adopt.
 *
 * Terminal handover reuses the Ink core's editor handoff pair —
 * `enterAlternateScreen()` pauses rendering, suspends raw-mode stdin, and
 * drops the extended key reporting that non-C SI-u editors (nano) choke on;
 * `exitAlternateScreen()` re-enters the alt screen (vim's rmcup pops back to
 * the main screen on quit), repaints, and resumes stdin. See ink.tsx.
 *
 * Editor resolution order mirrors readline's edit-and-execute-command:
 * `$VISUAL` → `$EDITOR` → `vi` on POSIX (always present). Windows has no
 * console-editor guarantee and `notepad` does not block, so an unresolved
 * editor there reports `unavailable` and the UI asks the user to set
 * `$EDITOR`. The variable may carry arguments (`EDITOR="code --wait"`), so
 * the command line is split quote-aware before spawning.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import instances from '../ink/instances.js'
import { shellQuote } from './shellQuote.js'

/** Outcome of one editor round-trip; the caller maps these to UI feedback. */
export type EditorOutcome =
  /** The saved content differs from the draft — adopt `text`. */
  | { kind: 'edited'; text: string }
  /** Unchanged, emptied-file kept as-is, or a non-zero exit (`:cq`) — keep the draft. */
  | { kind: 'unchanged' }
  /** No editor could be resolved (Windows without `$EDITOR`). */
  | { kind: 'unavailable' }
  /** The editor process failed to start. */
  | { kind: 'failed'; message: string }

/**
 * Split an `$EDITOR`-style command line into argv, honoring single/double
 * quotes (`code --wait`, `"C:\Program Files\...\nvim.exe" -f`).
 */
export function splitEditorCommand(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | null = null
  let hasToken = false
  for (const ch of commandLine) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== '' || hasToken) args.push(current)
      current = ''
      hasToken = false
      continue
    }
    current += ch
  }
  if (current !== '' || hasToken) args.push(current)
  return args
}

/**
 * Resolve the editor argv from the environment. `$VISUAL` wins over
 * `$EDITOR` (readline convention); POSIX falls back to `vi`, Windows has no
 * blocking console editor fallback and returns undefined.
 */
export function resolveEditorCommand(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const raw = (env.VISUAL ?? '').trim() || (env.EDITOR ?? '').trim()
  if (raw !== '') {
    const args = splitEditorCommand(raw)
    return args.length > 0 ? args : undefined
  }
  return process.platform === 'win32' ? undefined : ['vi']
}

/**
 * Run the editor to completion with the terminal attached. Windows `.cmd` /
 * `.bat` launchers (code.cmd, nvim-qt shims) cannot spawn directly and go
 * through cmd.exe with shell-quoted args, same as the updater's runProcess.
 */
function runEditor(argv: readonly string[], file: string): Promise<number> {
  return new Promise(resolve => {
    let settled = false
    const useShell =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(argv[0] ?? '')
    const child = spawn(argv[0]!, useShell ? shellQuote([...argv.slice(1), file]) : [...argv.slice(1), file], {
      stdio: 'inherit',
      shell: useShell,
    })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }
    child.once('error', () => finish(-1))
    child.once('close', code => finish(code ?? 1))
  })
}

/**
 * Edit `draft` in the user's editor and report what happened. The Ink
 * instance is looked up lazily (same pattern as Chat's Ctrl+L redraw) so the
 * util stays usable in tests and non-TTY contexts: without a live instance
 * the handover escapes are skipped and the editor simply inherits stdio.
 *
 * A trailing newline the editor appends on save is stripped; trailing
 * whitespace-only tail beyond that is left to the user. Saving the file
 * unchanged (or quitting without saving) keeps the caller's draft.
 */
export async function editInExternalEditor(draft: string): Promise<EditorOutcome> {
  const argv = resolveEditorCommand()
  if (argv === undefined) return { kind: 'unavailable' }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-prompt-'))
  // .md so markdown-aware editors highlight the draft like a chat message.
  const file = join(dir, 'input.md')
  await writeFile(file, draft, 'utf8')

  const ink = instances.get(process.stdout)
  ink?.enterAlternateScreen()
  let code: number
  try {
    code = await runEditor(argv, file)
  } catch {
    code = -1
  } finally {
    // The terminal must come back even when the editor crashed — a stuck
    // suspended stdin leaves the TUI dead on the alt screen.
    ink?.exitAlternateScreen()
  }

  if (code === -1) {
    await rm(dir, { recursive: true, force: true })
    return { kind: 'failed', message: argv[0]! }
  }

  let saved = ''
  try {
    saved = await readFile(file, 'utf8')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  if (code !== 0) return { kind: 'unchanged' }
  const text = saved.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return text === draft ? { kind: 'unchanged' } : { kind: 'edited', text }
}
