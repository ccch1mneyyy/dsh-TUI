/**
 * 输入粘贴的**共享语义**（PromptInput 与 Launchpad 复用；2026-10 方案 B）。
 *
 * 只抽两条输入真正同源的东西：
 * 1. **粘贴管线**——载荷清洗（win32 输入记录残渣、终端控制字节、\r 规整、
 *    bracketed paste 标记字节）与单行折叠；
 * 2. **组合键匹配**——`paste` 动作经 keymap 的生效组合键（可重映射），
 *    谁都不许再硬编码 `ctrl+v` 字符串。
 *
 * 明确**不**统一的语义（边界见 Launchpad/PromptInput 各自注释）：
 * - 多行/附件/图片暂存/历史/chip 折叠是聊天页编辑器的能力，落地页是单行
 *   首屏输入——多行内容在落地页折叠成一行（{@link collapseToSingleLine}），
 *   PromptInput 保留换行；
 * - 异步落点守则**同一条**（读回时必须用当下最新的文本/光标，闭包旧值一律
 *   不许用），实现各自落地：PromptInput 用 revision lease（与会话代次、图片
 *   租约耦合，搬动会改变聊天页行为），Launchpad 用每次渲染刷新的 current-ref
 *   （受控组件，props 即最新值）。
 */

import stripAnsi from 'strip-ansi'
import { actionMatches, type ComboKeyFlags } from './keymap.js'

/**
 * Editable prompt text must have one stable source-to-screen geometry. The
 * renderer interprets ANSI as zero-width styling and expands tabs relative to
 * global tab stops; keeping either in `value` would let wrapping/click mapping
 * count different cells and could split an escape sequence during selection.
 * Strip terminal controls and expand tabs at ingress while preserving newlines.
 */
const EDITABLE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/u

/**
 * Raw win32-input-mode records (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`) that reached the
 * editable buffer as text instead of being translated. `stripAnsi` consumes the
 * record head and leaves its terminating `_` in the draft — the stray
 * underscore users see after a multi-line paste (issue #1090). Only the full
 * record grammar (exactly five `;` separators) matches, so a real `_` and
 * ordinary bracket text survive untouched.
 *
 * Shape source: the same grammar `parse-keypress.ts` decodes at token level
 * (`WIN32_INPUT_RE`) and rewrites back into characters for a leaked payload
 * (`WIN32_RECORD_TEXT_RE`); the expressions must stay in sync.
 */
const WIN32_RECORD_RESIDUE = /\u001b\[\d*(?:;\d*){5}_/gu

/**
 * The same record with its ESC byte missing: what a record split across reads
 * leaves behind once its ESC was consumed as a key event. Printable, so it
 * survives `sanitizeEditableText`'s control probe untouched; typed text keeps
 * it because only a paste payload can carry a partial record.
 *
 * Two anchors keep the strip from deleting payload data (ADR-0008: a deletion
 * needs evidence that the shape CANNOT be a payload character):
 *
 * - `(?<!\u001b)` — a tail may never bite into a COMPLETE record. Without this
 *   anchor the strip sliced `ESC[13;28;13;1;0;1_ravo` down the middle, and
 *   `stripAnsi` then ate the orphan ESC together with the payload `r`
 *   (measured: 50 of the 94 printable followers were edible).
 * - `(?<![\p{L}\p{N}])` — a record-shaped run welded into the payload's own
 *   word (`…_x[13;28;13;1;0;1_y`) is indistinguishable from payload text and
 *   must stay visible (16 characters in the minimum case). A run that stands
 *   alone as its own protocol token is still the #1097 residue; the residual
 *   is recorded in T06-SUMMARY.
 *
 * The strip also runs AFTER {@link WIN32_RECORD_RESIDUE} — see
 * {@link sanitizePastedText} for why that order is a contract.
 */
const WIN32_RECORD_RESIDUE_TAIL = /(?<!\u001b)(?<![\p{L}\p{N}])\[\d*(?:;\d*){5}_/gu

/**
 * Normalize editable text so no terminal control characters remain in state.
 */
export function sanitizeEditableText(text: string): string {
  // Fast path for ordinary and multi-line drafts: newline is intentionally
  // absent from the probe, so large clean text returns without the
  // stripAnsi/control-normalization passes.
  if (!EDITABLE_CONTROL.test(text)) return text
  // Record residue goes first: `stripAnsi` would consume the CSI head and
  // leave only the terminating `_` behind.
  return stripAnsi(text.replace(WIN32_RECORD_RESIDUE, ''))
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '        ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

/**
 * Paste-payload ingress: consume a split record's ESC-less tail before
 * normalizing. The tail is printable, so it would survive
 * `sanitizeEditableText`'s control probe untouched; typed text keeps it
 * because only a paste payload can carry a partial record.
 *
 * The five separators only prove the *shape*, not that a record was split:
 * a user can legitimately paste the literal `[13;28;13;1;0;1_`. The tail rule
 * therefore keeps its two evidence requirements — the payload must carry a
 * complete ESC-bearing record, and the shape must stand alone as its own token
 * ({@link WIN32_RECORD_RESIDUE_TAIL}) — and, when they do not hold, the bytes
 * stay exactly as pasted (ADR-0002 zero-harm / ADR-0008 "keep it visible").
 */
export function sanitizePastedText(text: string): string {
  // Probe with String#match: the /g detection regex carries lastIndex state
  // across `.test` calls, so a previous success could skip a later match.
  const hasRecordStream = text.match(WIN32_RECORD_RESIDUE) !== null
  if (!hasRecordStream) return sanitizeEditableText(text)
  // Order is a contract (ADR-0002 decision 1, corrected): the COMPLETE records
  // go first, so the tail rule can never see a record's own body — otherwise
  // the record is sliced open and `stripAnsi` eats the orphan ESC plus the
  // payload character behind it. `sanitizeEditableText` then strips whatever
  // records are left.
  return sanitizeEditableText(
    text.replace(WIN32_RECORD_RESIDUE, '').replace(WIN32_RECORD_RESIDUE_TAIL, ''),
  )
}

/**
 * Strip literal bracketed-paste marker bytes (`\x1b[200~` / `\x1b[201~`).
 * ink's parser normally consumes them before `useInput` sees the payload;
 * this is the belt-and-braces pass for any path that receives raw bytes
 * (a flush boundary splitting marker from payload leaves them printable-side).
 */
export function stripBracketedPasteMarkers(text: string): string {
  return text.replace(/\u001b\[200~|\u001b\[201~/gu, '')
}

/**
 * Single-line paste fold (Launchpad 语义)：清洗后把换行折叠成一个空格——
 * 单行编辑器里 Enter 是提交，多行内容不许拼出换行。
 */
export function collapseToSingleLine(text: string): string {
  return sanitizePastedText(stripBracketedPasteMarkers(text)).replace(/[\r\n]+/gu, ' ')
}

/**
 * 按键是否命中 `paste` 动作的**生效**组合键（默认 Ctrl+V/Cmd+V + Alt+V 别名，
 * 可经 /settings 重映射）。唯一的组合键判定入口——调用方不许自己比键字符串。
 */
export function matchesPasteShortcut(input: string, key: ComboKeyFlags): boolean {
  return actionMatches('paste', input, key)
}

/**
 * 单行插入的纯计算：把已清洗文本落在给定光标处，返回新的文本与光标。
 * 调用方负责拿**当下最新**的 query/caret（异步落点守则），这里不做 IO。
 */
export function insertSingleLineAt(
  query: string,
  caret: number,
  text: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, query.length))
  return { text: query.slice(0, at) + text + query.slice(at), caret: at + text.length }
}
