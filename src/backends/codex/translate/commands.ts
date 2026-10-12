/**
 * Command display (docs/codex-backend-design.md §8.1): the shell wrapper
 * Codex runs a command in is not what the user should read, and a command
 * whose every parsed action only reads, searches or lists files renders as
 * that, not as a terminal (D12).
 */
import { arr, rec, str } from '../narrow.js'

/** `bash -lc '…'` at any path (`/bin/bash`, `/opt/homebrew/bin/bash`, a
 *  bare `bash`), also `sh`/`zsh`/`dash`/`ksh` and any `-c` flag cluster. */
const POSIX_WRAPPER = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c[a-z]*\s+([\s\S]+)$/u
/** `powershell.exe -Command …` / `pwsh -c …`, a quoted path allowed, with
 *  the usual switches before the script (any case). */
const POWERSHELL_WRAPPER = /^(?:"[^"]*?(?:powershell|pwsh)(?:\.exe)?"|\S*?(?:powershell|pwsh)(?:\.exe)?)(?:\s+-(?:NoProfile|NoLogo|NonInteractive|ExecutionPolicy\s+\S+))*\s+-(?:Command|c)\s+([\s\S]+)$/iu

/**
 * Undo one level of shell quoting when the whole script is exactly one
 * quoted word; undefined when it is not (several words, unbalanced quotes):
 * the caller then keeps the script as written, never a guess.
 */
function unquote(script: string): string | undefined {
  const trimmed = script.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
    // POSIX single quotes: `'"'"'` / `'\''` spell a literal quote inside.
    const inner = trimmed.slice(1, -1).replaceAll('\'"\'"\'', '\u0000').replaceAll('\'\\\'\'', '\u0000')
    return inner.includes('\'') ? undefined : inner.replaceAll('\u0000', '\'')
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1)
    return /(?<!\\)"/u.test(inner) ? undefined : inner.replace(/\\(["\\$`])/gu, '$1')
  }
  return /['"]/u.test(trimmed) ? undefined : trimmed
}

/**
 * The script inside a shell wrapper, unwrapped losslessly; undefined when
 * the command is not a recognised wrapper or its quoting is not one plain
 * word. Approval prompts show this (or the raw command): what they show is
 * exactly what will run.
 */
export function unwrapShell(command: string): string | undefined {
  const posix = POSIX_WRAPPER.exec(command.trim())
  if (posix !== null) return unquote(posix[1]!)
  const powershell = POWERSHELL_WRAPPER.exec(command.trim())
  if (powershell !== null) return unquote(powershell[1]!)
  return undefined
}

/** A card title's command: the unwrapped script, else (one parsed action)
 *  Codex's own reading of it, else the command as given. */
export function unwrapCommand(command: string, actions: unknown = []): string {
  const unwrapped = unwrapShell(command)
  if (unwrapped !== undefined) return unwrapped
  const list = arr(actions)
  if (list.length === 1) {
    const only = str(rec(list[0])?.command)
    if (only !== undefined && only !== '') return only
  }
  return command
}

/** A one-line title: the first line, `…` when more follow. */
export function commandTitle(command: string): string {
  const lines = command.split('\n')
  const first = lines[0]!.trimEnd()
  return lines.length > 1 ? `${first} …` : first
}

/** What a command does, from its parsed actions. */
export type CommandKind =
  | { readonly kind: 'read'; readonly paths: readonly string[] }
  | { readonly kind: 'search'; readonly query?: string; readonly path?: string }
  | { readonly kind: 'list'; readonly path?: string }
  | { readonly kind: 'exec' }

/** Classify by `commandActions`: only a uniform read/search/list command
 *  is not a terminal. */
export function classifyCommand(actions: unknown): CommandKind {
  const list = arr(actions).flatMap(action => {
    const value = rec(action)
    return value === undefined ? [] : [value]
  })
  if (list.length === 0) return { kind: 'exec' }
  const types = new Set(list.map(action => str(action.type)))
  if (types.size !== 1) return { kind: 'exec' }
  switch ([...types][0]) {
    case 'read': {
      const paths = list.flatMap(action => {
        const path = str(action.path) ?? str(action.name)
        return path === undefined || path === '' ? [] : [path]
      })
      return paths.length === 0 ? { kind: 'exec' } : { kind: 'read', paths }
    }
    case 'search': {
      if (list.length !== 1) return { kind: 'exec' }
      const query = str(list[0]!.query)
      const path = str(list[0]!.path)
      return { kind: 'search', ...(query === undefined || query === '' ? {} : { query }), ...(path === undefined || path === '' ? {} : { path }) }
    }
    case 'listFiles': {
      if (list.length !== 1) return { kind: 'exec' }
      const path = str(list[0]!.path)
      return { kind: 'list', ...(path === undefined || path === '' ? {} : { path }) }
    }
    default:
      return { kind: 'exec' }
  }
}
