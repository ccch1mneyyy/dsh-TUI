/**
 * The credential seam of the Claude channel profiles (phase 3): channel
 * tokens live in the DSH credential store — the same `~/.dsh/.credentials.yaml`
 * (0600) the /provider wizard writes through the dsh credentials service
 * (providerWizard.ts's deriveKeyRef convention) — and channels.json holds
 * only the derived `tokenRef`, never a literal token.
 *
 * This module is a direct, host-side file view of that store (the Claude
 * backend has no cordis context to resolve `ctx.get('credentials')` from).
 * The store is edited through a REAL YAML document parser (`yaml`, already
 * a runtime dependency): the top-level `refs` mapping is located semantically
 * — block or flow (inline) style, quoted keys included — foreign fields,
 * comments and multiline scalars keep their meaning, and every commit must
 * parse back clean before it is allowed to replace the file (R3-3: the old
 * line-append once turned a legal `refs: { A: b }` into a duplicate top-level
 * `refs:` key, corrupting the shared library for every strict parser). A
 * store this module cannot honestly read — unreadable, or not valid YAML —
 * is never rebuilt over: reads answer undefined and writes refuse.
 * Commits are atomic (atomic-file.ts).
 * The ref namespace is `CHANNEL_<SLUG>_TOKEN` — derived from the channel id
 * the way deriveKeyRef derives `<ROUTE>_API_KEY`, so a re-import (or a hand
 * edit of the name's slug) refreshes the same credential row.
 *
 * Token material never reaches a log, notice or event (auth.ts's module
 * contract): this module only ever moves it between the file and the spawn
 * pipeline.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, parseDocument, type Document, type YAMLMap } from 'yaml'
import { dshHomeDir } from '../../utils/credentials.js'
import { writeFileAtomic } from './atomic-file.js'

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

const FILE = '.credentials.yaml'

/** The file-backed token store under `home` (default the DSH home that owns
 * `~/.dsh/.credentials.yaml`). */
export function fileClaudeChannelTokens(home: string = dshHomeDir(), debug: (message: string) => void = () => undefined): ClaudeChannelTokens {
  const path = join(home, FILE)

  /** Parse the store into a YAML document. `undefined` = this module refuses
   *  to interpret (let alone rewrite) what it cannot honestly read: an
   *  unreadable file, or one that does not parse (a damaged or
   *  duplicate-keyed library must never be rebuilt over — R3-3). An absent
   *  file parses as an empty document, so the first write can create it. */
  const load = (): Document | undefined => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseDocument('')
      debug('claude: channel token store unreadable (' + (error instanceof Error ? error.message : String(error)) + '); refusing to touch it')
      return undefined
    }
    const doc = parseDocument(text)
    if (doc.errors.length > 0) {
      debug('claude: channel token store is not valid YAML (' + doc.errors.length + ' parse errors); refusing to touch it')
      return undefined
    }
    return doc
  }

  /** The top-level `refs` mapping: undefined when absent, null when the
   *  document holds a `refs` entry that is not a mapping (writes refuse on
   *  that shape instead of guessing around it). */
  const refsOf = (doc: Document): YAMLMap | undefined | null => {
    if (doc.contents === null) return undefined
    if (!isMap(doc.contents)) return null
    const refs = doc.contents.get('refs')
    if (refs === undefined) return undefined
    return isMap(refs) ? refs : null
  }

  const commit = (next: string): void => {
    try {
      writeFileAtomic(home, FILE, next)
    } catch (error) {
      debug('claude: channel token write failed (' + (error instanceof Error ? error.message : String(error)) + ')')
    }
  }
  return {
    read: ref => {
      const doc = load()
      if (doc === undefined) return undefined
      const refs = refsOf(doc)
      if (refs === undefined || refs === null) return undefined
      const value = refs.get(ref)
      // Only a non-empty string scalar is a token; null/number/boolean
      // scalars are declared but not usable credential material.
      return typeof value === 'string' && value !== '' ? value : undefined
    },
    write: (ref, value) => {
      const doc = load()
      if (doc === undefined) return
      const refs = refsOf(doc)
      if (refs === null) {
        debug('claude: channel token store refs is not a mapping; refusing to write')
        return
      }
      if (refs === undefined) doc.set('refs', { [ref]: value })
      else refs.set(ref, value)
      // lineWidth 0: a token is one scalar and must never be line-folded.
      const next = doc.toString({ lineWidth: 0 })
      // Self-check: nothing leaves this module unless it parses back clean
      // — R3-3's duplicate-refs class of corruption cannot be committed.
      if (parseDocument(next).errors.length > 0) {
        debug('claude: channel token write self-check failed; refusing to commit')
        return
      }
      if (next !== '') commit(next)
    },
    erase: ref => {
      const doc = load()
      if (doc === undefined) return
      const refs = refsOf(doc)
      if (refs === undefined || refs === null) return
      if (!refs.has(ref)) return
      refs.delete(ref)
      commit(doc.toString({ lineWidth: 0 }))
    },
    declared: ref => {
      const doc = load()
      if (doc === undefined) return false
      const refs = refsOf(doc)
      return refs !== undefined && refs !== null && refs.has(ref)
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
