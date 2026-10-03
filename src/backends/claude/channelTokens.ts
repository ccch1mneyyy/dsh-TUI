/**
 * The credential seam of the Claude channel profiles (phase 3): channel
 * tokens live in the DSH credential store — the same `~/.dsh/.credentials.yaml`
 * (0600) the /provider wizard writes through the dsh credentials service
 * (providerWizard.ts's deriveKeyRef convention) — and channels.json holds
 * only the derived `tokenRef`, never a literal token.
 *
 * This module is a direct, host-side file view of that store (the Claude
 * backend has no cordis context to resolve `ctx.get('credentials')` from):
 * one `  REF: value` line under the top-level `refs:` block, every other
 * line byte-preserved, commits atomic (channels.ts's temp+rename pattern).
 * The ref namespace is `CHANNEL_<SLUG>_TOKEN` — derived from the channel id
 * the way deriveKeyRef derives `<ROUTE>_API_KEY`, so a re-import (or a hand
 * edit of the name's slug) refreshes the same credential row.
 *
 * Token material never reaches a log, notice or event (auth.ts's module
 * contract): this module only ever moves it between the file and the spawn
 * pipeline.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomeDir } from '../../utils/credentials.js'

/** The credential ref of one channel id (the deriveKeyRef convention:
 *  uppercase, runs of non-alphanumerics → `_`). */
export function channelTokenRef(id: string): string {
  const cleaned = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return 'CHANNEL_' + (cleaned === '' ? 'CHANNEL' : cleaned) + '_TOKEN'
}

/** Read/write/erase access (injectable: tests use an in-memory store). */
export interface ClaudeChannelTokens {
  /** The stored token, or undefined when the ref holds nothing. */
  read(ref: string): string | undefined
  /** Store `value` under `ref` (best-effort: a failure reports to the
   *  debug log and the session carries on without the token). */
  write(ref: string, value: string): void
  /** Remove `ref` (a missing ref is fine). */
  erase(ref: string): void
  /** Whether `ref` is declared (the roster's `hasToken`). */
  declared(ref: string): boolean
}

/** Render one credential value as a YAML scalar (single-quoted only when the
 *  plain form could be misread; '' doubles inside, per the YAML rule). */
function yamlScalar(value: string): string {
  if (value === '' || /^[?-\[\]{}#&*!|>'"%@,]/.test(value) || /[:#]/.test(value) || /^\s|\s$/.test(value)
    || /[\n\r\t]/.test(value) || /^(true|false|null|~|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/.test(value)) {
    return "'" + value.replaceAll("'", "''") + "'"
  }
  return value
}

/** Unquote one YAML scalar the store may hold (plain or single-quoted). */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string } catch { return trimmed.slice(1, -1) }
  }
  return trimmed
}

const FILE = '.credentials.yaml'

/** Split text into lines that KEEP their trailing newline (splice-safe). */
function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/)
}

/** The file-backed token store under `home` (default the DSH home that owns
 *  `~/.dsh/.credentials.yaml`). */
export function fileClaudeChannelTokens(home: string = dshHomeDir(), debug: (message: string) => void = () => undefined): ClaudeChannelTokens {
  const path = join(home, FILE)
  const readAll = (): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  /** The `refs:` block's line range in `text` (both -1 when absent). */
  const refsBlock = (text: string): { start: number; end: number } => {
    const match = /^refs:[ \t]*\r?\n/m.exec(text)
    if (match === null) return { start: -1, end: -1 }
    const start = match.index + match[0].length
    let end = start
    while (end < text.length) {
      const lineEnd = text.indexOf('\n', end)
      const stop = lineEnd === -1 ? text.length : lineEnd
      const line = text.slice(end, stop)
      if (!/^([ \t]+\S|\s*$)/.test(line)) break
      end = lineEnd === -1 ? text.length : lineEnd + 1
    }
    return { start, end }
  }
  const findLine = (block: string, ref: string): number => {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const re = new RegExp('^[ \\t]+' + escaped + '[ \\t]*:', 'mu')
    const lines = splitLines(block)
    for (let at = 0; at < lines.length; at += 1) {
      if (re.test(lines[at]!)) return at
    }
    return -1
  }
  const commit = (next: string): void => {
    const temporary = join(home, FILE + '.' + process.pid + '.' + Date.now() + '.tmp')
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(temporary, next, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      try { chmodSync(temporary, 0o600) } catch { /* best-effort on odd filesystems */ }
      renameSync(temporary, path)
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The previous document is still intact; nothing else is safe to do.
      }
      debug('claude: channel token write failed (' + (error instanceof Error ? error.message : String(error)) + ')')
    }
  }
  return {
    read: ref => {
      const text = readAll()
      const block = refsBlock(text)
      if (block.start === -1) return undefined
      const lines = splitLines(text.slice(block.start, block.end))
      const at = findLine(text.slice(block.start, block.end), ref)
      if (at === -1) return undefined
      const line = lines[at] ?? ''
      const colon = line.indexOf(':')
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/\r?\n$/, '')
      const unquoted = unquote(value)
      return unquoted === '' ? undefined : unquoted
    },
    write: (ref, value) => {
      const text = readAll()
      const entry = '  ' + ref + ': ' + yamlScalar(value) + '\n'
      const block = refsBlock(text)
      let next: string
      if (block.start === -1) {
        const base = text === '' ? '' : text.endsWith('\n') ? text : text + '\n'
        next = base + 'refs:\n' + entry
      } else {
        const current = text.slice(block.start, block.end)
        const at = findLine(current, ref)
        const lines = splitLines(current)
        next = at === -1
          ? text.slice(0, block.start) + current + entry + text.slice(block.end)
          : text.slice(0, block.start) + lines.map((line, i) => i === at ? entry : line).join('') + text.slice(block.end)
      }
      if (next !== text) commit(next)
    },
    erase: ref => {
      const text = readAll()
      const block = refsBlock(text)
      if (block.start === -1) return
      const current = text.slice(block.start, block.end)
      const at = findLine(current, ref)
      if (at === -1) return
      const lines = splitLines(current)
      commit(text.slice(0, block.start) + lines.filter((_, i) => i !== at).join('') + text.slice(block.end))
    },
    declared: ref => {
      const text = readAll()
      const block = refsBlock(text)
      return block.start !== -1 && findLine(text.slice(block.start, block.end), ref) !== -1
    },
  }
}

/** An in-memory store (tests, embedders). */
export function memoryClaudeChannelTokens(initial: Record<string, string> = {}): ClaudeChannelTokens & { readonly data: Readonly<Record<string, string>> } {
  let data: Record<string, string> = { ...initial }
  return {
    get data() { return data },
    read: ref => data[ref],
    write: (ref, value) => { data = { ...data, [ref]: value } },
    erase: ref => { const next: Record<string, string> = {}; for (const [key, value] of Object.entries(data)) if (key !== ref) next[key] = value; data = next },
    declared: ref => Object.hasOwn(data, ref),
  }
}

/** Whether the DSH credential store file exists at all (diagnostics only). */
export function claudeChannelTokensFilePresent(home: string = dshHomeDir()): boolean {
  return existsSync(join(home, FILE))
}
