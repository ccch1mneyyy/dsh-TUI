/**
 * decode-osc7501 — OSC 7501（Program Status Protocol）报告的解码核心。
 *
 * 被 scripts/decode-osc7501.mjs（取证 CLI）与它的回归共用。
 *
 * **这里的每一个字节都是不可信输入。** 日志、stdin 甚至别的进程的抓包都可以
 * 塞进任意内容，而规范明确要求：解码后的 `msg`/`title` 含控制字符的报告整条
 * 丢弃（否则光是「看一眼日志」就能执行 OSC 52、清屏一类终端控制序列）。因此
 * 本模块的输出契约是硬性的——**没有任何来自报告的字节会未经转义进入输出**：
 *
 *   - `title`/`msg` 先按规范校验：base64 解不出、或解出来含 C0/DEL/C1，整条
 *     拒绝（`ok: false`），绝不展示解码结果；
 *   - 其余不可信字段（`state`、`app`、`id`、未知键、探测文本）统一经
 *     `escapeForDisplay()` 转成可见转义再展示。
 */

import { Buffer } from 'node:buffer'

/** 报告起始：`ESC ] 7501 ;`。 */
export const REPORT_PREFIX = '\x1b]7501;'

/** 一条报告的完整序列上限（规范 Limits 表：4096 字节）。 */
export const MAX_SEQUENCE_BYTES = 4096

/** C0、DEL、C1 —— 规范禁止出现在解码后 `msg`/`title` 里的字符。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u

const STATE_GLYPH = {
  idle: '○',
  working: '◐',
  blocked: '◼',
  done: '●',
  error: '✗',
  clear: '⌫',
}

const KNOWN_KEYS = ['state', 'kind', 'progress', 'app', 'id', 'title', 'msg']

/** 常见控制字符的可见写法；其余落在 `\xNN`。 */
const NAMED_ESCAPES = new Map([
  [0x07, '\\a'],
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0b, '\\v'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x1b, '\\e'],
])

/** 解码后的 `msg`/`title` 是否含控制字符（规范要求整条拒绝）。 */
export function hasControlChar(text) {
  return CONTROL_RE.test(text)
}

/**
 * 把不可信文本转成「只含可见字符」的一行：控制字符写成 `\e`/`\n`/`\xNN`，
 * 其余原样。这是本模块唯一的输出通道，任何来自报告的字段都必须先过这里。
 */
export function escapeForDisplay(text) {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x20 && code < 0x7f) || code > 0x9f) {
      out += char
      continue
    }
    out += NAMED_ESCAPES.get(code) ?? `\\x${code.toString(16).padStart(2, '0')}`
  }
  return out
}

/**
 * 规范的 base64（UTF-8 文本，padding 可省）。解不出返回 `null`：字符集不合法、
 * 长度不可能、或字节不是合法 UTF-8（否则会得到 U+FFFD 这种「看起来能显示」
 * 的假结果）。空串解出空串。
 */
export function decodeBase64(text) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return null
  const body = text.replace(/=+$/u, '')
  if (body.length % 4 === 1) return null
  const decoded = Buffer.from(body, 'base64').toString('utf8')
  return decoded.includes('\ufffd') ? null : decoded
}

/** 把一条报告 body 解析成 `key=value` 对；没有 `=` 或空键的 pair 按规范跳过。 */
export function parsePairs(body) {
  const out = {}
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

/**
 * 解释一条报告 body。
 *
 * `ok: false` 表示**整条按规范丢弃**（解码后含控制字符 / base64 不合法），
 * 此时只回报原因和一个转义过的 proof，绝不回报解码结果。
 */
export function interpretReport(body) {
  const trimmed = body.trim()
  if (trimmed.startsWith('?')) {
    return { ok: true, line: `探测回复/查询：${escapeForDisplay(trimmed)}` }
  }
  const pairs = parsePairs(body)
  const decoded = {}
  for (const key of ['title', 'msg']) {
    const raw = pairs[key]
    if (raw === undefined || raw === '') continue
    const text = decodeBase64(raw)
    if (text === null) {
      return { ok: false, reason: `${key} 不是合法 base64`, detail: escapeForDisplay(raw) }
    }
    if (hasControlChar(text)) {
      return { ok: false, reason: `解码后的 ${key} 含控制字符`, detail: escapeForDisplay(raw) }
    }
    decoded[key] = text
  }

  const state = pairs.state ?? '(缺 state)'
  const bits = [`${STATE_GLYPH[state] ?? '?'} ${escapeForDisplay(state)}`]
  if (pairs.kind !== undefined) bits.push(`kind=${escapeForDisplay(pairs.kind)}`)
  if (pairs.progress !== undefined) bits.push(`${escapeForDisplay(pairs.progress)}%`)
  if (pairs.app !== undefined) bits.push(`app=${escapeForDisplay(pairs.app)}`)
  if (pairs.id !== undefined) bits.push(`id=${escapeForDisplay(pairs.id)}`)
  if (decoded.title !== undefined) bits.push(`title="${escapeForDisplay(decoded.title)}"`)
  if (decoded.msg !== undefined) bits.push(`msg="${escapeForDisplay(decoded.msg)}"`)
  const unknown = Object.keys(pairs).filter(key => !KNOWN_KEYS.includes(key))
  if (unknown.length > 0) bits.push(`(未知键: ${unknown.map(escapeForDisplay).join(',')})`)
  return { ok: true, line: bits.join('  ') }
}

/**
 * 处理新到达的一段文本：返回其中**完整**的报告，并把可能还没读完的尾巴
 * （一段 `ESC ] 7501 ;` 开头、还没有终止符的内容）留给下一次调用。
 */
export function scanChunk(text) {
  const entries = []
  let cursor = 0
  for (const match of text.matchAll(/\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    entries.push(interpretReport(match[1] ?? ''))
    cursor = (match.index ?? 0) + match[0].length
  }
  return { entries, pending: retainPending(text.slice(cursor)) }
}

/** 只保留可能长成报告的那条尾巴（最后一段未终止的 `ESC ] 7501 ;`）。 */
function retainPending(rest) {
  const start = rest.lastIndexOf(REPORT_PREFIX)
  if (start < 0) return ''
  const pending = rest.slice(start)
  // 超过整条序列上限的内容永远不可能成为合法报告；留着只会让一份恶意日志
  // 把内存撑大（也永远不会被消费）。
  return Buffer.byteLength(pending, 'utf8') > MAX_SEQUENCE_BYTES ? '' : pending
}

/**
 * 增量读取一个**增长或截断**的字节源：只读上次之后新增的字节，跨读取边界的
 * 半条报告由 `scanChunk` 的尾巴兜住，源被截断/轮转时位置与尾巴一起重置。
 *
 * `size()` 返回源当前字节长度；`read(offset, length)` 返回该区间解码后的文本
 * （调用方负责在源被替换后换用新的句柄）。报告本体是 ASCII（键 + base64），
 * 所以按块解 UTF-8 不会切断报告；被切断的多字节字符只会落在被丢弃的渲染字节里。
 */
export function createIncrementalTail({ read, size }) {
  let offset = 0
  let pending = ''
  return {
    /** 已消费到的源偏移。 */
    offset: () => offset,
    /** 跨边界留待补全的半条报告。 */
    pending: () => pending,
    /** 读取并返回新增内容里的完整报告。 */
    poll() {
      const total = size()
      if (total < offset) {
        // 截断或轮转：旧位置与新尾巴都对不上新内容了。
        offset = 0
        pending = ''
      }
      if (total === offset) return []
      const chunk = read(offset, total - offset)
      offset = total
      const scanned = scanChunk(pending + chunk)
      pending = scanned.pending
      return scanned.entries
    },
  }
}
