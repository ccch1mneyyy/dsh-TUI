/**
 * Pick a terminal emulator for the Linux `Terminal=true` open path and build
 * the spawn descriptor. The TUI itself owns a tty but hands child processes
 * `stdio: 'ignore'`, so a terminal application must get its own window; this
 * is the piece the generic `xdg-open` path lacks (it executes `Exec=` directly).
 *
 * Selection order: `$TERMINAL` (may carry arguments, e.g. `kitty -1`) → KDE's
 * `kdeglobals` `[General] TerminalApplication` → `xdg-terminal-exec` → the
 * first known terminal on PATH. Each terminal gets its own command separator
 * (`kitty`/`foot` take the program directly, `konsole`/`xterm` use `-e`,
 * GNOME Terminal uses `--`, wezterm uses `start --`, XFCE/MATE/Terminator use `-x`).
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { splitCommandLine } from './commandLine.js'

/** A terminal command split into the emulator args and the program separator. */
export interface TerminalSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly separator: readonly string[]
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Whether `command` resolves to an executable on PATH (or is an executable path). */
export function isExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command === '') return false
  if (command.includes('/')) return isExecutableFile(command)
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    if (isExecutableFile(join(dir, command))) return true
  }
  return false
}

/** How a terminal takes the program to run. */
function separatorFor(file: string): readonly string[] {
  switch (basename(file).replace(/\.exe$/i, '')) {
    case 'kitty':
    case 'foot':
    case 'xdg-terminal-exec':
      return []
    case 'wezterm':
      return ['start', '--']
    case 'gnome-terminal':
      return ['--']
    case 'xfce4-terminal':
    case 'mate-terminal':
    case 'terminator':
      return ['-x']
    default:
      return ['-e']
  }
}

function specFor(commandLine: string): TerminalSpec | undefined {
  const argv = splitCommandLine(commandLine)
  const file = argv[0]
  if (file === undefined || file === '') return undefined
  return { file, args: argv.slice(1), separator: separatorFor(file) }
}

/** KDE stores its terminal choice in `~/.config/kdeglobals` (`[General]`). */
function readKdeTerminal(env: NodeJS.ProcessEnv): TerminalSpec | undefined {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config')
  let text: string
  try {
    text = readFileSync(join(configHome, 'kdeglobals'), 'utf8')
  } catch {
    return undefined
  }
  let inGeneral = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      inGeneral = line === '[General]'
      continue
    }
    if (!inGeneral) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    if (line.slice(0, eq).trim() !== 'TerminalApplication') continue
    const value = line.slice(eq + 1).trim()
    return value === '' ? undefined : specFor(value)
  }
  return undefined
}

const FALLBACK_TERMINALS = ['kitty', 'ghostty', 'konsole', 'alacritty', 'wezterm', 'foot', 'rio', 'gnome-terminal', 'xterm']

/** Resolve the terminal command, or undefined when none is available. */
export function resolveTerminal(env: NodeJS.ProcessEnv = process.env): TerminalSpec | undefined {
  const explicit = env.TERMINAL?.trim() ?? ''
  if (explicit !== '') {
    const spec = specFor(explicit)
    if (spec !== undefined && isExecutableOnPath(spec.file, env)) return spec
  }
  // A stale kdeglobals value must not shadow a working xdg-terminal-exec or
  // the known-terminal fallbacks below.
  const kde = readKdeTerminal(env)
  if (kde !== undefined && isExecutableOnPath(kde.file, env)) return kde
  if (isExecutableOnPath('xdg-terminal-exec', env)) {
    return { file: 'xdg-terminal-exec', args: [], separator: [] }
  }
  for (const file of FALLBACK_TERMINALS) {
    if (isExecutableOnPath(file, env)) return { file, args: [], separator: separatorFor(file) }
  }
  return undefined
}

/** Assemble the final argv: terminal args, separator, then the handler argv. */
export function buildTerminalSpawn(
  terminal: TerminalSpec,
  argv: readonly string[],
): { file: string; args: string[] } {
  return { file: terminal.file, args: [...terminal.args, ...terminal.separator, ...argv] }
}
