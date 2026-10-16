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
 * 安全：输入是不可信字节流（日志/stdin 都可能夹带控制字符、OSC 52 之类的
 * payload）。解码、转义与「解码后含控制字符即整条拒绝」的规则都在
 * ./lib/decode-osc7501.mjs，本 CLI 只负责读取与打印——绝不把报告里的字节
 * 直接写进 stdout。
 *
 * 这不是 CI 门禁条目（回归见 scripts/verify-decode-osc7501.mjs；
 * 协议层回归见 scripts/verify-osc7501.tsx）；本脚本只做解码与展示。
 */

import { closeSync, openSync, readSync, statSync, watchFile } from 'node:fs'
import { Buffer } from 'node:buffer'
import { createIncrementalTail, scanChunk } from './lib/decode-osc7501.mjs'

let printed = 0
let rejected = 0

/** 打印一批解码结果；被拒绝的报告只说明原因与转义过的证据。 */
function printEntries(entries) {
  for (const entry of entries) {
    if (entry.ok) {
      printed += 1
      console.log(`${String(printed).padStart(4)}  ${entry.line}`)
    } else {
      rejected += 1
      console.log(`   ✗ 跳过（${entry.reason}）：${entry.detail}`)
    }
  }
}

const summary = () =>
  `\n共 ${printed} 条 OSC 7501 序列${rejected === 0 ? '' : `，跳过 ${rejected} 条非法报告`}`

const args = process.argv.slice(2)
const follow = args.includes('--follow') || args.includes('-f')
// `-` 是 stdin 的显式目标，不能被当成 flag 过滤掉。
const target = args.find(a => a === '-' || !a.startsWith('-'))

if (target === undefined) {
  console.error('用法: node scripts/decode-osc7501.mjs [--follow] <pty-log|->')
  process.exit(2)
}

if (target === '-') {
  // 半条报告的尾巴留到下一个 chunk，避免解码出残片。
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    const scanned = scanChunk(pending + chunk)
    pending = scanned.pending
    printEntries(scanned.entries)
  })
  process.stdin.on('end', () => {
    console.log(summary())
  })
} else {
  // 只读上次之后新增的字节：既能实时 --follow，也不会每来一行普通渲染字节
  // 就重放一遍全部历史报告。读取偏移与半条报告的尾巴都在 createIncrementalTail
  // 里维护；文件被截断/轮转时它重置位置，下面的 size() 顺手换个句柄。
  let descriptor = -1
  let seenSize = 0
  const closeTarget = () => {
    if (descriptor >= 0) closeSync(descriptor)
    descriptor = -1
  }
  const currentSize = () => {
    let total
    try {
      total = statSync(target).size
    } catch {
      return 0
    }
    // 截断或轮转：旧句柄指向的内容已经不是这个文件了，丢掉它让 readRange
    // 重新打开（读取位置由 createIncrementalTail 一并重置）。
    if (total < seenSize) closeTarget()
    seenSize = total
    return total
  }
  const readRange = (offset, length) => {
    if (descriptor < 0) descriptor = openSync(target, 'r')
    const buffer = Buffer.allocUnsafe(length)
    const got = readSync(descriptor, buffer, 0, length, offset)
    return buffer.toString('utf8', 0, got)
  }
  const tail = createIncrementalTail({ read: readRange, size: currentSize })
  const poll = () => {
    try {
      printEntries(tail.poll())
    } catch {
      // 文件暂时读不到（还没建出来 / 已被删掉）：当作没有新内容。
    }
  }

  poll()
  if (follow) {
    console.log(`跟踪 ${target}（Ctrl+C 退出）…\n`)
    watchFile(target, { interval: 200 }, poll)
  } else {
    closeTarget()
    console.log(summary())
    if (printed === 0) {
      console.log('没有抓到 OSC 7501。检查：dsh-tui 是否真的在 pty 里跑过（stdout 必须是 TTY），')
      console.log('以及 DSH_TUI_PROGRAM_STATUS 未被设为 0/false/no/off。')
    }
  }
}
