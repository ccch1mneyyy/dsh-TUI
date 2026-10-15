/**
 * OSC 7501 — Program Status Protocol
 *
 * A terminal escape sequence that lets a program tell the terminal what it is
 * doing: idle, working, blocked on the user, done, or failed. The terminal
 * owns presentation; the program only shares state.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 *
 * Wire format (the body is `:`-separated `key=value` pairs):
 *
 *   ESC ] 7501 ; state=working:app=dsh-tui:msg=<base64> ESC \
 *   ESC ] 7501 ; ?                                        ESC \   (detection)
 *
 * Every report REPLACES the addressed record, so a key that must survive has
 * to be repeated on every report. Terminals that do not know the sequence
 * ignore it, which is why reports are sent blind — no detection round trip.
 *
 * This module is pure encoding/parsing: no I/O, no React, no channel imports.
 * The value charset excludes `:` and `;`, so nothing needs escaping; free-text
 * values (`msg`, `title`) are base64 of single-line, control-free UTF-8.
 */

import { Buffer } from 'buffer'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { ESC, ESC_TYPE } from './ansi.js'
import { OSC } from './osc.js'

/** The OSC command number for the Program Status Protocol. */
export const PROGRAM_STATUS = OSC.PROGRAM_STATUS

/** `ESC ]` — the OSC introducer. */
const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC)

/**
 * Protocol hard caps. A report that breaks one is discarded whole by the
 * terminal, so the encoder refuses to build it instead of truncating into a
 * half-applied record.
 */
export const PROGRAM_STATUS_LIMITS = {
  /** Whole sequence, OSC through ST. The largest legal report is under 3300. */
  sequenceBytes: 4096,
  /** Encoded `msg` bytes (base64 of at most 2048 decoded). */
  msgEncodedBytes: 2732,
  /** Decoded `msg` bytes. */
  msgDecodedBytes: 2048,
  /** Encoded `title` bytes (base64 of at most 192 decoded). */
  titleEncodedBytes: 256,
  /** Decoded `title` bytes. */
  titleDecodedBytes: 192,
  /** `app` bytes. */
  appBytes: 32,
  /** Total `id` bytes. */
  idBytes: 128,
  /** `id` bytes per `/`-separated segment. */
  idSegmentBytes: 32,
} as const

/** States a report may carry. `clear` removes records instead of setting one. */
export type ProgramState =
  | 'idle'
  | 'working'
  | 'done'
  | 'blocked'
  | 'error'
  | 'clear'

/** What a `blocked` record is waiting for. */
export type ProgramBlockedKind = 'permission' | 'question' | 'auth'

/**
 * One OSC 7501 report. `app` is included by the encoder on every report
 * because each report replaces its record completely.
 */
export type ProgramStatusRecord = {
  state: ProgramState
  /**
   * Record path such as `build/test`. Omitted addresses the root record,
   * which is what a single-program TUI uses.
   */
  id?: string
  /** Stable machine-readable program id, e.g. `dsh-tui`. */
  app?: string
  /** Only meaningful with `blocked`; ignored by the terminal otherwise. */
  kind?: ProgramBlockedKind
  /** Only meaningful with `working`/`blocked`; 0-100, absent = indeterminate. */
  progress?: number
  /** Short human-readable label (base64 on the wire). */
  title?: string
  /** One human-readable line (base64 on the wire). */
  msg?: string
}

/**
 * Collapse free text to the single control-free line the protocol requires.
 * Control characters (C0/C1, DEL) and line breaks would be rejected by a
 * conforming terminal and can smuggle sequence boundaries, so they are
 * dropped rather than escaped — there is no escape mechanism in the format.
 * @param text - untrusted text (session titles, tool commands, model output).
 * @returns the text with control characters and line breaks removed.
 */
export function sanitizeProgramText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Truncate to a byte budget on a code-point boundary, so a multi-byte
 * character is never split into invalid UTF-8.
 * @param text - the text to bound.
 * @param maxBytes - the UTF-8 byte budget.
 * @returns the longest prefix within the budget.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/**
 * Base64 of sanitized, byte-bounded UTF-8 text.
 *
 * The protocol caps free text twice — on the decoded bytes and on the encoded
 * base64 — and the decoded cap is the binding one (base64 of 2048 bytes is
 * exactly 2732, of 192 exactly 256). Both are enforced so a future cap change
 * cannot silently produce an over-long value.
 * @param text - the raw text to encode.
 * @param decodedMaxBytes - the decoded UTF-8 byte budget.
 * @param encodedMaxBytes - the encoded base64 byte budget.
 * @returns the base64 value, or `''` when the text is empty after sanitizing.
 */
function encodeText(text: string, decodedMaxBytes: number, encodedMaxBytes: number): string {
  const clean = truncateUtf8(sanitizeProgramText(text), decodedMaxBytes)
  if (clean === '') return ''
  const encoded = Buffer.from(clean, 'utf8').toString('base64')
  return encoded.length > encodedMaxBytes ? '' : encoded
}

/** `id` grammar: `/`-separated `[A-Za-z0-9_.+-]` segments. */
function isValidRecordId(id: string): boolean {
  if (id.length === 0 || Buffer.byteLength(id, 'utf8') > PROGRAM_STATUS_LIMITS.idBytes) return false
  const segments = id.split('/')
  if (segments.length > 8) return false
  return segments.every(segment =>
    segment.length > 0
    && Buffer.byteLength(segment, 'utf8') <= PROGRAM_STATUS_LIMITS.idSegmentBytes
    && /^[A-Za-z0-9_.+-]+$/.test(segment))
}

/** `app` grammar: `[A-Za-z0-9_.+-]{1,32}`. */
function isValidApp(app: string): boolean {
  return app.length > 0
    && Buffer.byteLength(app, 'utf8') <= PROGRAM_STATUS_LIMITS.appBytes
    && /^[A-Za-z0-9_.+-]+$/.test(app)
}

/**
 * Build one OSC 7501 report.
 *
 * Returns `''` when the record cannot be encoded legally (unknown state,
 * `kind`/`progress` on a state that forbids it, an `app`/`id` outside its
 * grammar, or a body past the sequence cap) — callers skip the write rather
 * than send a report the terminal would discard.
 *
 * The sequence is NOT wrapped for tmux/screen passthrough on purpose: a
 * passthrough report would reach the outer terminal, which cannot tell panes
 * apart and cannot see the program exit, breaking the protocol's record
 * lifetime. A multiplexer that implements OSC 7501 receives it directly.
 *
 * @param record - the report to encode.
 * @returns the complete sequence, or `''` when it cannot be encoded.
 */
export function programStatus(record: ProgramStatusRecord): string {
  const { state } = record
  if (state === 'clear') return clearProgramStatus()

  const pairs: string[] = [`state=${state}`]

  if (record.id !== undefined) {
    if (!isValidRecordId(record.id)) return ''
    pairs.push(`id=${record.id}`)
  }

  if (record.kind !== undefined) {
    // `kind` is only defined for `blocked`; anything else must not carry it.
    if (state !== 'blocked') return ''
    if (record.kind !== 'permission' && record.kind !== 'question' && record.kind !== 'auth') return ''
    pairs.push(`kind=${record.kind}`)
  }

  if (record.progress !== undefined) {
    // `progress` is only defined for `working`/`blocked`.
    if (state !== 'working' && state !== 'blocked') return ''
    if (!Number.isInteger(record.progress) || record.progress < 0 || record.progress > 100) return ''
    pairs.push(`progress=${record.progress}`)
  }

  if (record.app !== undefined) {
    if (!isValidApp(record.app)) return ''
    pairs.push(`app=${record.app}`)
  }

  if (record.title !== undefined) {
    const encoded = encodeText(
      record.title,
      PROGRAM_STATUS_LIMITS.titleDecodedBytes,
      PROGRAM_STATUS_LIMITS.titleEncodedBytes,
    )
    if (encoded !== '') pairs.push(`title=${encoded}`)
  }

  if (record.msg !== undefined) {
    const encoded = encodeText(
      record.msg,
      PROGRAM_STATUS_LIMITS.msgDecodedBytes,
      PROGRAM_STATUS_LIMITS.msgEncodedBytes,
    )
    if (encoded !== '') pairs.push(`msg=${encoded}`)
  }

  const body = pairs.join(':')
  // ST-terminate: the spec allows BEL or ST, and ST avoids BEL side effects
  // (tmux bell-action, terminal beeps) on the terminals that implement this.
  const sequence = `${OSC_PREFIX}${PROGRAM_STATUS};${body}${ESC}\\`
  if (Buffer.byteLength(sequence, 'utf8') > PROGRAM_STATUS_LIMITS.sequenceBytes) return ''
  return sequence
}

/**
 * Build a `clear` report. With an `id`, removes that record and every record
 * beneath it; without one, removes every record on the terminal.
 *
 * Note the protocol already drops `working`/`blocked` records when the process
 * exits or the next shell prompt begins, and deliberately keeps `done`/`error`
 * for the user to find — so a normal exit must NOT clear.
 * @param id - the record path to remove; omitted clears every record.
 * @returns the complete sequence, or `''` when the id is malformed.
 */
export function clearProgramStatus(id?: string): string {
  if (id === undefined) return `${OSC_PREFIX}${PROGRAM_STATUS};state=clear${ESC}\\`
  if (!isValidRecordId(id)) return ''
  return `${OSC_PREFIX}${PROGRAM_STATUS};state=clear:id=${id}${ESC}\\`
}

/**
 * Whether to report program status.
 *
 * On by default: the protocol is a no-op on terminals that do not implement
 * it (unknown OSCs are ignored), so the only hard requirement is an
 * interactive stdout — a piped or redirected one has no terminal to report
 * to. `DSH_TUI_PROGRAM_STATUS` disables it with any falsy spelling
 * (`0`, `false`, `no`, `off`).
 *
 * @param stdoutIsTTY - whether stdout is an interactive terminal.
 * @param env - the environment to read the opt-out from.
 * @returns true when reports should be emitted.
 */
export function supportsProgramStatus(
  stdoutIsTTY: boolean = process.stdout.isTTY === true,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!stdoutIsTTY) return false
  const flag = env.DSH_TUI_PROGRAM_STATUS
  if (flag === undefined || flag === '') return true
  return isEnvTruthy(flag)
}
