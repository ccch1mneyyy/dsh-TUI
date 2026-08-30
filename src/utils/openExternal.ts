/**
 * Open URLs, files and folders with the platform's default handler, fully
 * detached from the TUI process (fire-and-forget: no stdio pipes, no wait,
 * child unref'd so the TUI can exit without waiting for the handler).
 *
 * Launch strategy per platform:
 * - Windows files/URLs: `start` is a cmd.exe builtin, so everything goes
 *   through `$comspec /d /s /c start "" "<target>"` using the vendored
 *   cross-spawn quoting (shellQuote.ts) with windowsVerbatimArguments —
 *   the same protocol externalEditor.ts uses for .cmd shims.
 * - Windows DIRECTORIES: `powershell (New-Object -ComObject
 *   Shell.Application).Open('<dir>')`. Explorer's single-instance
 *   forwarding silently swallows "open folder" requests on many systems
 *   (field-diagnosed: `start`, raw explorer and `/select,` all dead while
 *   the COM API works), so folders bypass ShellExecute entirely. This
 *   powershell child must NOT be spawned detached: libuv maps
 *   `detached: true` to DETACHED_PROCESS (a console-less process) and in
 *   that state the Shell.Application Open call silently does nothing
 *   (field-diagnosed via spawn matrix: detached+hide dead, hide-only
 *   works) — `windowsHide` alone (CREATE_NO_WINDOW) keeps it invisible
 *   AND functional.
 * - macOS: `open` (reveal adds `-R`).
 * - Linux/other: `xdg-open`.
 */
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { cmdEscapeArgument } from './shellQuote.js'
import { logError } from './log.js'

/**
 * Spawn a fire-and-forget child: no stdio pipes, no wait, unref'd so the
 * TUI can exit without waiting for the handler. On Windows `detach`
 * controls the DETACHED_PROCESS flag — it must stay false for the
 * Shell.Application COM channel (console-less PowerShell swallows the
 * Open call; see buildWin32OpenSpawn). Failures are logged, never
 * thrown — an unopenable target (missing handler, sandboxed desktop)
 * must not disturb the TUI. `onError` lets callers degrade (e.g.
 * reveal → open parent folder).
 */
function spawnDetached(
  file: string,
  args: readonly string[],
  opts: { verbatim?: boolean; detach?: boolean; onError?: () => void } = {},
): void {
  const { verbatim = false, detach = true, onError } = opts
  try {
    const child = spawn(file, [...args], {
      stdio: 'ignore',
      detached: detach,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    })
    child.on('error', error => {
      logError(error)
      onError?.()
    })
    child.unref()
  } catch (error) {
    logError(error)
    onError?.()
  }
}

/**
 * Windows `start` via cmd.exe: `start "" "<target>"` (the empty quoted
 * title is mandatory — start would otherwise treat a quoted target as the
 * window title). Exported for tests: assembly is pure.
 */
export function buildWin32StartSpawn(target: string): { file: string; args: string[]; verbatim: true; detach: true } {
  const line = ['start', cmdEscapeArgument(''), cmdEscapeArgument(target)].join(' ')
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
    detach: true,
  }
}

/** Whether `target` exists on disk as a directory (decides the open
 *  channel: folders bypass the ShellExecute verb and go through the
 *  Shell.Application COM API). Never throws. */
export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * The Windows spawn descriptor for opening `target` (pure, testable):
 * directories go through `powershell (New-Object -ComObject
 * Shell.Application).Open('<dir>')`, everything else (files, URLs) through
 * `start`. Explorer's single-instance forwarding silently swallows
 * "open folder" requests on many systems (diagnosed in the field: `start`,
 * raw explorer, and `/select,` all dead while the COM API works), so the
 * COM channel is the reliable folder opener; single quotes in the path are
 * doubled for the PowerShell literal. The COM descriptor also carries
 * `detach: false` — a DETACHED_PROCESS (console-less) PowerShell silently
 * drops the Shell.Application Open call, so the channel only works with
 * `windowsHide` (CREATE_NO_WINDOW) alone (field-diagnosed spawn matrix:
 * detached+hide → dead, hide-only → works; start keeps working detached).
 */
export function buildWin32OpenSpawn(target: string): { file: string; args: string[]; verbatim: boolean; detach: boolean } {
  if (isDirectory(target)) {
    const literal = target.replace(/'/g, "''")
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-Command', `(New-Object -ComObject Shell.Application).Open('${literal}')`],
      verbatim: false,
      detach: false,
    }
  }
  return buildWin32StartSpawn(target)
}

/** Open a URL, file or directory with the platform's default handler. */
export function openExternal(target: string): void {
  if (target === '') return
  if (process.platform === 'win32') {
    const cmd = buildWin32OpenSpawn(target)
    // If the primary channel cannot even spawn (e.g. PowerShell missing on
    // an exotic system), fall back to `start` — reliable on healthy boxes.
    spawnDetached(cmd.file, cmd.args, {
      verbatim: cmd.verbatim,
      detach: cmd.detach,
      onError: () => {
        if (cmd.file !== (process.env.ComSpec || 'cmd.exe')) {
          const fb = buildWin32StartSpawn(target)
          spawnDetached(fb.file, fb.args, { verbatim: fb.verbatim })
        }
      },
    })
  } else if (process.platform === 'darwin') {
    spawnDetached('open', [target])
  } else {
    spawnDetached('xdg-open', [target])
  }
}

/** Open a file with its associated application (openExternal with a file). */
export function openFile(path: string): void {
  openExternal(path)
}

/**
 * Open the folder containing `filePath` in the platform file manager.
 *
 * Windows and Linux open the parent DIRECTORY through openExternal —
 * Windows routes folders through the Shell.Application COM channel (see
 * buildWin32OpenSpawn). macOS uses `open -R` to select the file, degrading
 * to the folder when the file is gone. No-op when neither the file nor its
 * parent exists (a stale/hallucinated path must not spawn error dialogs).
 */
export function revealInFileManager(filePath: string): void {
  if (filePath === '') return
  const dir = dirname(filePath)
  if (process.platform === 'darwin') {
    if (existsSync(filePath)) {
      spawnDetached('open', ['-R', filePath], {
        onError: () => {
          if (existsSync(dir)) openExternal(dir)
        },
      })
      return
    }
    if (existsSync(dir)) openExternal(dir)
    return
  }
  if (existsSync(dir)) openExternal(dir)
}
