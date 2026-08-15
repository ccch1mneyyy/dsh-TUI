/**
 * External editor round-trip for the prompt input (issue #123): Ctrl+X dumps
 * the current draft into a temp file, hands the terminal to `$VISUAL` /
 * `$EDITOR` (nvim, vim, nano, `code --wait`, …), and returns the saved text
 * for the input to adopt.
 *
 * Terminal handover reuses the Ink core's editor handoff pair —
 * `enterAlternateScreen()` pauses rendering, suspends raw-mode stdin, and
 * drops the extended key reporting that non-CSI-u editors (nano) choke on;
 * `exitAlternateScreen()` re-enters the alt screen (vim's rmcup pops back to
 * the main screen on quit), repaints, and resumes stdin. See ink.tsx. The
 * resume deliberately happens only AFTER the saved file is read back and the
 * temp dir is removed: resuming stdin earlier would let keystrokes typed
 * right at editor exit race the prompt's `setValue` and get overwritten.
 *
 * Editor resolution order mirrors readline's edit-and-execute-command:
 * `$VISUAL` → `$EDITOR` → `vi` on POSIX (always present). Windows has no
 * console-editor guarantee and `notepad` does not block, so an unresolved
 * editor there reports `unavailable` and the UI asks the user to set
 * `$EDITOR`. The variable may carry arguments (`EDITOR="code --wait"`), so
 * the command line is split quote-aware before spawning.
 *
 * Windows launch: libuv resolves bare names to `.exe` on PATH but will NOT
 * execute `.cmd`/`.bat` shims (VS Code's `code` on PATH is `code.cmd`), and
 * `spawn(..., {shell: true})` with arguments triggers DEP0190 on Node 24+.
 * So bare commands are resolved against PATH/PATHEXT up front, and shim
 * scripts go through an explicit `cmd.exe /d /s /c` with a shell-quoted,
 * outer-quoted command line (the cross-spawn quoting pattern) — no
 * `shell: true` anywhere.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import instances from '../ink/instances.js'
import { shellQuote } from './shellQuote.js'

/**
 * Outcome of one editor round-trip; the caller maps these to UI feedback:
 * - `edited`: the saved content differs from the draft — adopt `text`
 * - `unchanged`: the file matches the draft, or the editor exited non-zero
 *   (`:cq` abort semantics) — keep the draft
 * - `unavailable`: no editor could be resolved (Windows without `$EDITOR`)
 * - `failed`: the editor process or the temp-file round-trip errored
 *   (`message` names the failed command or carries the fs error)
 */
export type EditorOutcome =
  | { kind: 'edited'; text: string }
  | { kind: 'unchanged' }
  | { kind: 'unavailable' }
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
 * blocking console editor fallback and returns undefined. `platform` is a
 * parameter so the Windows branch is unit-testable from CI's Linux runners.
 */
export function resolveEditorCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const raw = (env.VISUAL ?? '').trim() || (env.EDITOR ?? '').trim()
  if (raw !== '') {
    const args = splitEditorCommand(raw)
    return args.length > 0 ? args : undefined
  }
  return platform === 'win32' ? undefined : ['vi']
}

/**
 * Windows shim resolution: a bare command like `code` usually lives on PATH
 * as `code.cmd`, which libuv refuses to execute directly. Walk PATH with
 * PATHEXT (case-insensitive on Windows; both casings tried for tests on
 * case-sensitive filesystems) and report whether the resolved file needs
 * cmd.exe to run. Commands carrying an explicit extension are used as-is;
 * unresolved names fall back to the bare command (spawn then resolves
 * `.exe`, or fails into the `failed` outcome).
 */
export function resolveWindowsShim(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; viaCmd: boolean } {
  if (/\.[a-z0-9]+$/i.test(command)) {
    return { command, viaCmd: /\.(cmd|bat)$/i.test(command) }
  }
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(ext => ext.trim())
    .filter(ext => ext !== '')
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      for (const casing of [ext, ext.toLowerCase()]) {
        const candidate = join(dir, command + casing)
        if (existsSync(candidate)) {
          return { command: candidate, viaCmd: /\.(cmd|bat)$/i.test(candidate) }
        }
      }
    }
  }
  return { command, viaCmd: false }
}

/**
 * Run the editor to completion with the terminal attached; resolves to the
 * exit code, or -1 when the process could not start. Windows shim scripts
 * (`.cmd`/`.bat`) go through an explicit `cmd.exe /d /s /c` — the outer
 * quotes are cmd's own `/s` convention so the inner shell-quoted line is
 * executed verbatim, and `shell: true` (DEP0190 with args on Node 24+) is
 * never used.
 */
function runEditor(argv: readonly string[], file: string): Promise<number> {
  return new Promise(resolve => {
    let settled = false
    let child
    if (process.platform === 'win32') {
      const shim = resolveWindowsShim(argv[0]!)
      if (shim.viaCmd) {
        const line = shellQuote([shim.command, ...argv.slice(1), file]).join(' ')
        child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'inherit' })
      } else {
        child = spawn(shim.command, [...argv.slice(1), file], { stdio: 'inherit' })
      }
    } else {
      child = spawn(argv[0]!, [...argv.slice(1), file], { stdio: 'inherit' })
    }
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }
    child.once('error', () => finish(-1))
    child.once('close', code => finish(code ?? 1))
  })
}

/** Error text for the `failed` outcome, err.message when available. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Edit `draft` in the user's editor and report what happened. Never throws:
 * every filesystem or spawn failure maps to a `failed` outcome so the UI
 * can notify instead of dying on an unhandled rejection.
 *
 * The Ink instance is looked up lazily (same pattern as Chat's Ctrl+L
 * redraw) so the util stays usable in tests and non-TTY contexts: without a
 * live instance the handover escapes are skipped and the editor simply
 * inherits stdio.
 *
 * Newline handling: a saved file identical to the draft is `unchanged`.
 * Otherwise ONE trailing newline is stripped when the draft did not end
 * with one — that is the terminating newline editors append on save, not
 * user content. Trailing blank lines the user actually added (or had in
 * the draft, e.g. from Shift+Enter) survive untouched.
 */
export async function editInExternalEditor(draft: string): Promise<EditorOutcome> {
  const argv = resolveEditorCommand()
  if (argv === undefined) return { kind: 'unavailable' }

  let handed = false
  const ink = instances.get(process.stdout)
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-prompt-'))
    // .md so markdown-aware editors highlight the draft like a chat message.
    const file = join(dir, 'input.md')
    await writeFile(file, draft, 'utf8')

    ink?.enterAlternateScreen()
    handed = true
    const code = await runEditor(argv, file)
    // Read back and clean up BEFORE the finally resumes stdin — keystrokes
    // typed the moment the editor exits must not race the prompt adopting
    // the result.
    const saved = await readFile(file, 'utf8').catch(() => null)
    await rm(dir, { recursive: true, force: true })

    if (code === -1) return { kind: 'failed', message: argv[0]! }
    if (code !== 0 || saved === null) return { kind: 'unchanged' }
    const normalized = saved.replace(/\r\n/g, '\n')
    if (normalized === draft) return { kind: 'unchanged' }
    const text =
      !draft.endsWith('\n') && normalized.endsWith('\n')
        ? normalized.slice(0, -1)
        : normalized
    return text === draft ? { kind: 'unchanged' } : { kind: 'edited', text }
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) }
  } finally {
    // The terminal must come back even when the editor crashed — a stuck
    // suspended stdin leaves the TUI dead on the alt screen.
    if (handed) ink?.exitAlternateScreen()
  }
}
