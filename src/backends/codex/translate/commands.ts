/**
 * Command display (docs/codex-backend-design.md §8.1): the shell wrapper
 * Codex runs a command in is not what the user should read, and a command
 * whose every parsed action only reads, searches or lists files renders as
 * that, not as a terminal (D12).
 */
import { arr, rec, str } from '../narrow.js'

/** `/bin/bash -lc '…'` (also `sh`/`zsh`, `-c`, `/usr/bin/…`). */
const POSIX_WRAPPER = /^(?:\/usr)?\/bin\/(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/u
/** `powershell.exe -Command …` / `pwsh -Command …` (any case). */
const POWERSHELL_WRAPPER = /^(?:[A-Za-z]:\\[^"]*\\)?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/iu

/** Undo one level of shell quoting around a whole script. */
function unquote(script: string): string {
  const trimmed = script.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
    // POSIX single quotes: `'"'"'` is how a literal quote is spelled inside.
    return trimmed.slice(1, -1).replaceAll('\'"\'"\'', '\'').replaceAll('\'\\\'\'', '\'')
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/gu, '$1')
  }
  return trimmed
}

/** The command as the user would have typed it. */
export function unwrapCommand(command: string, actions: unknown = []): string {
  const posix = POSIX_WRAPPER.exec(command)
  if (posix !== null) return unquote(posix[1]!)
  const powershell = POWERSHELL_WRAPPER.exec(command)
  if (powershell !== null) return unquote(powershell[1]!)
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
