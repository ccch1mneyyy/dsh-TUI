/**
 * Local token-usage ledger (`~/.dsh-tui/usage.jsonl`), the data behind
 * `/usage`.
 *
 * DSH's session logs are the transcript's source of truth, but they carry no
 * rolled-up spend and reading every log on every `/usage` would make the
 * command scale with the user's whole history. This ledger is the TUI's own
 * append-only side record instead: one line per turn that consumed tokens,
 * written at `turn/end`, priced with the table in force at that moment (so a
 * session straddling the off-peak boundary is not re-priced wholesale later).
 *
 * It therefore only knows about turns run since the feature landed, and a
 * deleted file simply starts the history over — both are stated by `/usage`
 * rather than papered over.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const LEDGER_FILE = 'usage.jsonl'

/**
 * Size at which the ledger is trimmed to {@link KEEP_RECORDS}. A turn record
 * is ~160 bytes, so this holds well over a year of heavy use before the
 * oldest lines start rolling off.
 */
const MAX_BYTES = 4 * 1024 * 1024
/** Records kept when a trim happens (newest first in the file's tail). */
const KEEP_RECORDS = 10_000

/** One turn's token usage, as persisted. */
export interface UsageRecord {
  /** Epoch milliseconds of the turn's end. */
  at: number
  /** Session id the turn belonged to. */
  session: string
  /** Provider route of the turn. */
  provider: string
  /** Model id of the turn. */
  model: string
  /** Cache-miss input tokens. */
  input: number
  /** Generated output tokens. */
  output: number
  /** Cache-hit input tokens. */
  cacheRead: number
  /** Tokens written into the prompt cache. */
  cacheWrite: number
  /** Estimated spend, absent when no price table entry matched the model. */
  amount?: number
  /** Currency of `amount`. */
  currency?: string
}

/** Totals over one time window. */
export interface UsageWindow {
  /** Turns recorded in the window. */
  turns: number
  /** Cache-miss input tokens. */
  input: number
  /** Generated output tokens. */
  output: number
  /** Cache-hit input tokens. */
  cacheRead: number
  /** Tokens written into the prompt cache. */
  cacheWrite: number
  /** Summed spend of the records priced in the summary's currency. */
  amount: number
  /** Turns whose spend is unknown (no price entry, or another currency). */
  unpriced: number
}

/** Per-model totals across the whole ledger. */
export interface UsageByModel {
  model: string
  turns: number
  /** Every token kind, summed. */
  tokens: number
  amount: number
  unpriced: number
}

/** What `/usage` renders. */
export interface UsageSummary {
  /** Currency the amounts are in (the newest priced record's). */
  currency: string
  /** Epoch milliseconds of the oldest record, when the ledger is non-empty. */
  since: number | undefined
  today: UsageWindow
  week: UsageWindow
  month: UsageWindow
  all: UsageWindow
  /** Largest spend first, then largest token count. */
  models: readonly UsageByModel[]
}

/** A finite, non-negative integer from durable JSON, or 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Parse one ledger line; anything not shaped like a record yields undefined
 * so a truncated tail (a killed process mid-append) costs one line, not the
 * whole history.
 * @param line - Raw JSONL line.
 */
export function parseUsageRecord(line: string): UsageRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const raw = parsed as Record<string, unknown>
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : undefined
  return {
    at: raw.at,
    session: typeof raw.session === 'string' ? raw.session : '',
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    input: count(raw.input),
    output: count(raw.output),
    cacheRead: count(raw.cacheRead),
    cacheWrite: count(raw.cacheWrite),
    ...(amount === undefined ? {} : { amount }),
    ...(typeof raw.currency === 'string' ? { currency: raw.currency } : {}),
  }
}

/**
 * Every ledger record, oldest first. Best-effort: a missing or unreadable
 * file reads as an empty history.
 * @param dir - Data directory (injectable for tests).
 */
export function readUsageRecords(dir: string = DATA_DIR): UsageRecord[] {
  let text: string
  try {
    text = readFileSync(join(dir, LEDGER_FILE), 'utf8')
  } catch {
    return []
  }
  const records: UsageRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const record = parseUsageRecord(line)
    if (record !== undefined) records.push(record)
  }
  return records
}

/**
 * Append one turn to the ledger, trimming the file when it outgrows
 * {@link MAX_BYTES}. Best-effort: a read-only home directory costs the
 * `/usage` history, never the turn.
 * @param record - The turn to record.
 * @param dir - Data directory (injectable for tests).
 * @returns True when the line was written.
 */
export function appendUsageRecord(record: UsageRecord, dir: string = DATA_DIR): boolean {
  const path = join(dir, LEDGER_FILE)
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  } catch {
    return false
  }
  try {
    if (statSync(path).size > MAX_BYTES) {
      const kept = readUsageRecords(dir).slice(-KEEP_RECORDS)
      writeFileSync(path, kept.map(entry => `${JSON.stringify(entry)}\n`).join(''))
    }
  } catch {
    // A failed trim only means the file stays large; the record is written.
  }
  return true
}

/** Add one record's tokens (and spend, when it matches) into a window. */
function fold(window: UsageWindow, record: UsageRecord, currency: string): void {
  window.turns += 1
  window.input += record.input
  window.output += record.output
  window.cacheRead += record.cacheRead
  window.cacheWrite += record.cacheWrite
  if (record.amount !== undefined && (record.currency ?? currency) === currency) {
    window.amount += record.amount
  } else {
    window.unpriced += 1
  }
}

function emptyWindow(): UsageWindow {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, amount: 0, unpriced: 0 }
}

/**
 * Roll the ledger up for `/usage`.
 *
 * "Today" is the local calendar day (that is the day the user means);
 * week/month are rolling 7- and 30-day windows ending at `now`, which stays
 * honest at a month boundary in a way "this month" does not.
 *
 * Amounts are summed only for records already priced in the summary's
 * currency — the newest priced record's. Changing `pricing.json` currency
 * therefore reports the old records as unpriced instead of adding
 * incompatible numbers together.
 *
 * @param records - Ledger records in any order.
 * @param now - Epoch milliseconds to anchor the windows to.
 */
export function summarizeUsage(records: readonly UsageRecord[], now: number): UsageSummary {
  const currency = [...records].reverse().find(r => r.amount !== undefined)?.currency ?? 'USD'
  const summary: UsageSummary = {
    currency,
    since: records.length === 0 ? undefined : Math.min(...records.map(r => r.at)),
    today: emptyWindow(),
    week: emptyWindow(),
    month: emptyWindow(),
    all: emptyWindow(),
    models: [],
  }
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const dayStart = startOfToday.getTime()
  const weekStart = now - 7 * 24 * 60 * 60 * 1000
  const monthStart = now - 30 * 24 * 60 * 60 * 1000

  const byModel = new Map<string, UsageByModel>()
  for (const record of records) {
    fold(summary.all, record, currency)
    if (record.at >= monthStart) fold(summary.month, record, currency)
    if (record.at >= weekStart) fold(summary.week, record, currency)
    if (record.at >= dayStart) fold(summary.today, record, currency)

    const key = record.model === '' ? 'unknown' : record.model
    const entry = byModel.get(key) ?? { model: key, turns: 0, tokens: 0, amount: 0, unpriced: 0 }
    entry.turns += 1
    entry.tokens += record.input + record.output + record.cacheRead + record.cacheWrite
    if (record.amount !== undefined && (record.currency ?? currency) === currency) {
      entry.amount += record.amount
    } else {
      entry.unpriced += 1
    }
    byModel.set(key, entry)
  }
  summary.models = [...byModel.values()].sort(
    (a, b) => b.amount - a.amount || b.tokens - a.tokens || a.model.localeCompare(b.model),
  )
  return summary
}
