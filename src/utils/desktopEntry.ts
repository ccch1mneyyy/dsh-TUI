/**
 * Minimal XDG desktop-entry support for the Linux "open with the default
 * handler" path. The generic `xdg-open` path executes an entry's `Exec`
 * without a `Terminal=true` wrapper, so a terminal application such as
 * `vim.desktop` is spawned with the TUI's non-tty stdio and exits at once.
 * This module supplies the missing pieces:
 *
 * - locate an entry by desktop-file ID (`vim.desktop`) in the XDG data dirs,
 *   including the legacy `vendor-app.desktop` → `vendor/app.desktop` form;
 * - parse the `[Desktop Entry]` group (`Exec`, `Terminal`, `Hidden`,
 *   `TryExec`, `Name`, `Path`), ignoring `[Desktop Action …]` groups;
 * - expand the Exec field codes for one target path (`%f`/`%F`/`%u`/`%U`,
 *   `%%`, `%c`, `%k`; `%i` is dropped because a terminal app has no icon).
 *
 * Deliberately narrower than the full desktop-entry spec: unknown field codes
 * and malformed quoting return `undefined`, and the caller falls back to
 * `xdg-open` rather than guessing.
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One parsed `[Desktop Entry]` group. */
export interface DesktopEntry {
  readonly id: string
  readonly path: string
  readonly exec: string
  readonly terminal: boolean
  readonly hidden: boolean
  readonly name?: string
  readonly tryExec?: string
  readonly workingDirectory?: string
}

const DEFAULT_DATA_DIRS = '/usr/local/share:/usr/share'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Unescape the desktop-entry string escapes (`\s`, `\n`, `\t`, `\r`, `\\`). */
function unescapeDesktopValue(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = value[i + 1]
    if (next === undefined) {
      out += '\\'
      continue
    }
    i++
    switch (next) {
      case 's': out += ' '; break
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      default: out += next; break
    }
  }
  return out
}

/** Pick `Name[locale]` (with a language fallback) before the unlocalized Name. */
function localizedName(values: Map<string, string>, locale: string | undefined): string | undefined {
  const fallback = values.get('Name')
  if (locale === undefined || locale.trim() === '') return fallback
  const base = locale.trim().split('.')[0]
  if (base === undefined || base === '') return fallback
  const normalized = base.replace('-', '_')
  const language = normalized.split('_')[0]
  for (const candidate of [normalized, normalized.replace('_', '-'), language]) {
    if (candidate === undefined || candidate === '') continue
    const value = values.get(`Name[${candidate}]`)
    if (value !== undefined && value !== '') return value
  }
  return fallback
}

/**
 * Parse the `[Desktop Entry]` group of a desktop file. Returns undefined when
 * the group is missing or carries no `Exec=` line (a hidden entry with an Exec
 * is still returned; callers check {@link DesktopEntry.hidden}). `locale`
 * selects a `Name[locale]` variant for the `%c` field code.
 */
export function parseDesktopEntry(
  text: string,
  id: string,
  path: string,
  locale: string | undefined = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG,
): DesktopEntry | undefined {
  const values = new Map<string, string>()
  let inEntry = false
  let foundEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      const group = line.slice(1, -1)
      if (group === 'Desktop Entry') {
        inEntry = true
        foundEntry = true
        continue
      }
      if (inEntry) break
      continue
    }
    if (!inEntry) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values.set(line.slice(0, eq).trim(), unescapeDesktopValue(line.slice(eq + 1).trim()))
  }
  if (!foundEntry) return undefined
  const exec = values.get('Exec') ?? ''
  if (exec === '') return undefined
  const name = localizedName(values, locale)
  const tryExec = values.get('TryExec')
  const workingDirectory = values.get('Path')
  return {
    id,
    path,
    exec,
    terminal: (values.get('Terminal') ?? '').trim().toLowerCase() === 'true',
    hidden: (values.get('Hidden') ?? '').trim().toLowerCase() === 'true',
    ...(name === undefined ? {} : { name }),
    ...(tryExec === undefined ? {} : { tryExec }),
    ...(workingDirectory === undefined || workingDirectory === '' ? {} : { workingDirectory }),
  }
}

/**
 * Resolve a desktop-file ID to its path under `$XDG_DATA_HOME` /
 * `$XDG_DATA_DIRS`. IDs containing path separators or `..` are rejected, so a
 * value coming from `xdg-mime` cannot escape the applications directories.
 */
export function findDesktopEntry(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const trimmed = id.trim()
  if (trimmed === '' || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return undefined
  const names = trimmed.endsWith('.desktop') ? [trimmed] : [trimmed, `${trimmed}.desktop`]
  const candidates: string[] = []
  for (const name of names) {
    candidates.push(name)
    if (name.includes('-')) candidates.push(name.replace('-', '/'), name.replace(/-/g, '/'))
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS?.trim() || DEFAULT_DATA_DIRS).split(':')
  for (const root of [dataHome, ...dataDirs]) {
    if (root === '') continue
    for (const candidate of candidates) {
      const path = join(root, 'applications', candidate)
      if (isFile(path)) return path
    }
  }
  return undefined
}

/**
 * Split an Exec line into tokens. Handles the desktop-entry quoting subset:
 * double quotes group an argument and backslash escapes the next character;
 * single quotes are ordinary characters, matching the spec.
 */
function tokenizeExec(exec: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let hasToken = false
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i]!
    if (quoted) {
      if (ch === '\\') {
        const next = exec[i + 1]
        if (next === undefined) return undefined
        i++
        current += next
      } else if (ch === '"') {
        quoted = false
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      hasToken = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    if (ch === '\\') {
      const next = exec[i + 1]
      if (next === undefined) {
        current += '\\'
      } else {
        i++
        current += next
      }
      hasToken = true
      continue
    }
    current += ch
    hasToken = true
  }
  if (quoted) return undefined
  if (hasToken) tokens.push(current)
  return tokens
}

interface ExpandState {
  replaced: boolean
}

/** Expand one Exec token; undefined means "unsupported, fall back". */
function expandToken(
  token: string,
  target: string,
  uri: string,
  entry: DesktopEntry,
  state: ExpandState,
): string | undefined {
  let out = ''
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!
    if (ch !== '%') {
      out += ch
      continue
    }
    const code = token[i + 1]
    if (code === undefined) return undefined
    i++
    switch (code) {
      case '%': out += '%'; break
      case 'f':
      case 'F':
        out += target
        state.replaced = true
        break
      case 'u':
      case 'U':
        out += uri
        state.replaced = true
        break
      case 'c':
        out += entry.name ?? ''
        state.replaced = true
        break
      case 'k': out += entry.path; break
      case 'i':
        state.replaced = true
        break
      // Deprecated field codes are dropped rather than executed literally.
      case 'd':
      case 'D':
      case 'n':
      case 'N':
      case 'v':
      case 'm':
        break
      default:
        return undefined
    }
  }
  return out
}

/**
 * Expand a desktop entry's `Exec` line for one target. Following the generic
 * `xdg-open` path, append the target only when no file, URL, `%c` or `%i`
 * substitution occurred. Returns undefined for malformed quoting or an
 * unknown field code, so the caller can fall back to `xdg-open`.
 */
export function expandExec(exec: string, target: string, entry: DesktopEntry): string[] | undefined {
  const tokens = tokenizeExec(exec)
  if (tokens === undefined) return undefined
  const uri = pathToFileURL(target).href
  const state: ExpandState = { replaced: false }
  const argv: string[] = []
  for (const token of tokens) {
    const expanded = expandToken(token, target, uri, entry, state)
    if (expanded === undefined) return undefined
    if (expanded !== '' || token === '') argv.push(expanded)
  }
  if (!state.replaced) argv.push(target)
  return argv.length === 0 ? undefined : argv
}
