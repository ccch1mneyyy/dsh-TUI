/**
 * Token price table for the `/cost` and `/usage` estimates.
 *
 * DSH meters tokens, not money — the provider bills separately and exposes
 * no cost API — so a spend figure can only ever be an estimate computed from
 * a local price list. The list shipped here is transcribed from DeepSeek's
 * published pricing page on {@link BUILT_IN_PRICES}.asOf and WILL go stale:
 * `~/.dsh-tui/pricing.json` overrides any part of it, and both readouts name
 * which list they used so a wrong number is traceable rather than mysterious.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

/** Peak-hour rates for one model, per 1M tokens in the table's currency. */
export interface ModelPrice {
  /** Input tokens served from the prompt cache. */
  cacheHitInput: number
  /** Input tokens that missed the cache. */
  input: number
  /** Generated output tokens. */
  output: number
  /** Tokens written into the prompt cache; defaults to the `input` rate,
   *  which is what DeepSeek charges (a cache write is a cache miss). */
  cacheWriteInput?: number
}

/** A complete price list: rates, currency, and the off-peak schedule. */
export interface PriceTable {
  /** ISO 4217 code the rates are quoted in. */
  currency: string
  /** Date the rates were transcribed, shown with the estimate. */
  asOf: string
  /** Where the rates came from, shown with the estimate. */
  source: string
  /** Peak windows as `HH:MM` UTC pairs, each `[start, end)`. */
  peakWindowsUtc: readonly (readonly [string, string])[]
  /** Factor applied to every rate outside the peak windows. */
  offPeakFactor: number
  /** Peak rates by model id. */
  models: Readonly<Record<string, ModelPrice>>
}

/**
 * Rates transcribed from https://api-docs.deepseek.com/quick_start/pricing.
 * Peak rates; off-peak is half. Check the page before trusting a number —
 * see the module doc for the override file.
 */
export const BUILT_IN_PRICES: PriceTable = {
  currency: 'USD',
  asOf: '2026-08-18',
  source: 'api-docs.deepseek.com/quick_start/pricing',
  peakWindowsUtc: [['01:00', '04:00'], ['06:00', '10:00']],
  offPeakFactor: 0.5,
  models: {
    'deepseek-v4-flash': { cacheHitInput: 0.014, input: 0.44, output: 1.32 },
    'deepseek-v4-pro': { cacheHitInput: 0.044, input: 1.32, output: 3.96 },
  },
}

/** Token counts for one priced unit of work (a message, turn, or session). */
export interface PricedUsage {
  /** Cache-miss input tokens. */
  input: number
  /** Generated output tokens. */
  output: number
  /** Cache-hit input tokens. */
  cacheRead: number
  /** Tokens written into the prompt cache. */
  cacheWrite: number
}

/** `HH:MM` → minutes past midnight, or undefined when malformed. */
function parseClock(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (match === null) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Whether a moment falls outside every peak window (so the off-peak factor
 * applies). Windows are half-open `[start, end)` and may wrap midnight.
 * @param table - The price table whose schedule applies.
 * @param at - Epoch milliseconds.
 */
export function isOffPeak(table: PriceTable, at: number): boolean {
  const date = new Date(at)
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return !table.peakWindowsUtc.some(([from, to]) => {
    const start = parseClock(from)
    const end = parseClock(to)
    if (start === undefined || end === undefined) return false
    return start <= end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end
  })
}

/**
 * The rates for a model id: an exact entry first, then the longest table key
 * the id starts with, so a dated release (`deepseek-v4-pro-0813`) inherits
 * its family's rates.
 * @param table - The price table to search.
 * @param model - Model id from the live route.
 * @returns The rates, or undefined when the table does not price the model.
 */
export function findModelPrice(table: PriceTable, model: string): ModelPrice | undefined {
  const exact = table.models[model]
  if (exact !== undefined) return exact
  let best: { key: string; price: ModelPrice } | undefined
  for (const [key, price] of Object.entries(table.models)) {
    if (!model.startsWith(key)) continue
    if (best === undefined || key.length > best.key.length) best = { key, price }
  }
  return best?.price
}

/**
 * Estimated spend for one unit of work, in the table's currency.
 * @param table - The price table to apply.
 * @param model - Model id from the live route.
 * @param usage - Token counts to price.
 * @param at - Epoch milliseconds, deciding peak vs off-peak.
 * @returns The amount, or undefined when the table does not price the model.
 */
export function estimateCost(
  table: PriceTable,
  model: string,
  usage: PricedUsage,
  at: number,
): number | undefined {
  const price = findModelPrice(table, model)
  if (price === undefined) return undefined
  const perMillion =
    usage.cacheRead * price.cacheHitInput +
    usage.input * price.input +
    usage.cacheWrite * (price.cacheWriteInput ?? price.input) +
    usage.output * price.output
  const factor = isOffPeak(table, at) ? table.offPeakFactor : 1
  return (perMillion / 1_000_000) * factor
}

/** A finite, non-negative number, or undefined. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** One `models` entry, or undefined when a required rate is missing. */
function parseModelPrice(value: unknown): ModelPrice | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const cacheHitInput = positiveNumber(raw.cacheHitInput)
  const input = positiveNumber(raw.input)
  const output = positiveNumber(raw.output)
  if (cacheHitInput === undefined || input === undefined || output === undefined) return undefined
  const cacheWriteInput = positiveNumber(raw.cacheWriteInput)
  return { cacheHitInput, input, output, ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }) }
}

/**
 * Overlay a user price file onto a base table. Every field is optional and
 * an unparseable one is dropped rather than failing the whole file — a typo
 * in one model's rates must not silently zero out the estimate for the rest.
 * `models` merges by id, so a file naming one model keeps the others.
 * @param text - Raw file contents.
 * @param base - Table to overlay (the built-in list in production).
 * @returns The merged table; `base` unchanged when nothing parsed.
 */
export function parsePriceTable(text: string, base: PriceTable = BUILT_IN_PRICES): PriceTable {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return base
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return base
  const raw = parsed as Record<string, unknown>

  const models: Record<string, ModelPrice> = { ...base.models }
  if (raw.models !== null && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
    for (const [id, entry] of Object.entries(raw.models as Record<string, unknown>)) {
      const price = parseModelPrice(entry)
      if (price !== undefined) models[id] = price
    }
  }

  const windows: (readonly [string, string])[] = []
  if (Array.isArray(raw.peakWindowsUtc)) {
    for (const window of raw.peakWindowsUtc) {
      if (!Array.isArray(window) || window.length !== 2) continue
      if (parseClock(window[0]) === undefined || parseClock(window[1]) === undefined) continue
      windows.push([window[0] as string, window[1] as string])
    }
  }

  const offPeakFactor = positiveNumber(raw.offPeakFactor)
  return {
    currency: typeof raw.currency === 'string' && raw.currency !== '' ? raw.currency : base.currency,
    asOf: typeof raw.asOf === 'string' && raw.asOf !== '' ? raw.asOf : base.asOf,
    source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : 'user',
    peakWindowsUtc: Array.isArray(raw.peakWindowsUtc) ? windows : base.peakWindowsUtc,
    offPeakFactor: offPeakFactor ?? base.offPeakFactor,
    models,
  }
}

/**
 * The effective price table: the built-in list with `~/.dsh-tui/pricing.json`
 * overlaid. Best-effort — a missing or unreadable file yields the built-in
 * list unchanged.
 * @param dir - Prefs directory (injectable for tests).
 */
export function loadPriceTable(dir: string = DATA_DIR): PriceTable {
  try {
    return parsePriceTable(readFileSync(join(dir, 'pricing.json'), 'utf8'))
  } catch {
    return BUILT_IN_PRICES
  }
}

/**
 * Render an amount for the transcript: enough decimals that a single cheap
 * turn is not rounded to zero, without printing noise on a large total.
 * @param amount - Amount in `currency`.
 * @param currency - ISO 4217 code.
 */
export function formatAmount(amount: number, currency: string): string {
  const digits = amount >= 1 ? 2 : 4
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
  const rendered = amount.toFixed(digits)
  return symbol === '' ? `${rendered} ${currency}` : `${symbol}${rendered}`
}
