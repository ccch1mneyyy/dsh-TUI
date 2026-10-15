#!/usr/bin/env node
/**
 * decode-osc7501.mjs — 取证/交互工具：从 pty 抓取的字节流里解码 OSC 7501
 * （Program Status Protocol）报告，用人眼可读的形式打印。
 *
 * 用途：终端本身还没实现 OSC 7501（或你想确认 dsh-tui 到底发了什么）时，
 * 目视确认协议工作正常。用法：
 *
 *   # 1) 在真实 pty 里录一段 dsh-tui 会话（script 到处都有）
 *   script -q -c "node bin/dsh-tui.js" /tmp/dsh-tui.raw
 *
 *   # 2) 解码（退出 dsh-tui 后跑，或另开一个终端窗格 --follow 实时看）
 *   node scripts/decode-osc7501.mjs /tmp/dsh-tui.raw
 *   node scripts/decode-osc7501.mjs --follow /tmp/dsh-tui.raw
 *
 * 也接受 stdin：`some-producer | node scripts/decode-osc7501.mjs -`
 *
 * 注意：script 录的是「程序→终端」方向的字节，OSC 7501 报告就在其中。
 * dsh-tui 的 DSH_TUI_RENDER_LOG 抓不到它——那条路径只记录帧差分，而状态
 * 报告经 writeRaw 直写 stdout。
 *
 * 这不是 CI 回归（回归见 scripts/verify-osc7501.tsx）；本脚本只做解码与
 * 展示，不参与任何门禁。
 */

import { readFileSync, statSync, watchFile } from 'node:fs'
import { Buffer } from 'node:buffer'

const ESC = '\x1b'
/** 报告：ESC ] 7501 ; <body> (BEL | ST)。body 不含 ESC/BEL。 */
const REPORT_RE = /\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g

const STATE_GLYPH = {
  idle: '○',
  working: '◐',
  blocked: '◼',
  done: '●',
  error: '✗',
  clear: '⌫',
}

const KNOWN_KEYS = ['state', 'kind', 'progress', 'app', 'id', 'title', 'msg']

function b64(text) {
  try {
    return Buffer.from(text, 'base64').toString('utf8')
  } catch {
    return '<base64 解码失败>'
  }
}

/** 把一条报告 body 解析成 `key=value` 对。 */
function parsePairs(body) {
  const out = {}
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

/** 人类可读的一行。 */
function render(body) {
  if (body.trimStart().startsWith('?')) return `探测回复/查询：${body.trim()}`
  const p = parsePairs(body)
  const state = p.state ?? '(缺 state)'
  const bits = [`${STATE_GLYPH[state] ?? '?'} ${state}`]
  if (p.kind) bits.push(`kind=${p.kind}`)
  if (p.progress) bits.push(`${p.progress}%`)
  if (p.app) bits.push(`app=${p.app}`)
  if (p.id) bits.push(`id=${p.id}`)
  if (p.title) bits.push(`title="${b64(p.title)}"`)
  if (p.msg) bits.push(`msg="${b64(p.msg)}"`)
  const unknown = Object.keys(p).filter(k => !KNOWN_KEYS.includes(k))
  if (unknown.length > 0) bits.push(`(未知键: ${unknown.join(',')})`)
  return bits.join('  ')
}

let printed = 0
/** 打印 text 中所有**完整**报告，返回已消费到的字节下标。 */
function feedComplete(text) {
  let end = 0
  for (const match of text.matchAll(REPORT_RE)) {
    printed += 1
    console.log(`${String(printed).padStart(4)}  ${render(match[1] ?? '')}`)
    end = match.index + match[0].length
  }
  return end
}

const args = process.argv.slice(2)
const follow = args.includes('--follow') || args.includes('-f')
// `-` 是 stdin 的显式目标，不能被当成 flag 过滤掉。
const target = args.find(a => a === '-' || !a.startsWith('-'))

if (target === undefined) {
  console.error('用法: node scripts/decode-osc7501.mjs [--follow] <pty-log|->')
  process.exit(2)
}

if (target === '-') {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buf += chunk
    // 只消费完整报告：半条报告的尾巴留到下一个 chunk，避免解码出残片。
    const consumed = feedComplete(buf)
    if (consumed > 0) buf = buf.slice(consumed)
  })
  process.stdin.on('end', () => {
    if (buf !== '') feedComplete(buf)
    console.log(`\n共 ${printed} 条 OSC 7501 序列`)
  })
} else {
  // 每次都重读整个文件、只打印新报告：比增量切片简单，也不会把文件末尾
  // 那条**完整**报告误判成"不完整尾巴"而丢掉。
  const readNew = () => {
    let text
    try {
      text = readFileSync(target, 'utf8')
    } catch {
      return
    }
    feedComplete(text)
  }
  readNew()
  if (follow) {
    console.log(`跟踪 ${target}（Ctrl+C 退出）…\n`)
    watchFile(target, { interval: 200 }, readNew)
  } else {
    console.log(`\n共 ${printed} 条 OSC 7501 序列`)
    if (printed === 0) {
      console.log('没有抓到 OSC 7501。检查：dsh-tui 是否真的在 pty 里跑过（stdout 必须是 TTY），')
      console.log('以及 DSH_TUI_PROGRAM_STATUS 未被设为 0/false/no/off。')
    }
  }
}
