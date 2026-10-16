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
  // 里维护；长度缩回（截断）由它自己发现，路径被换成另一个文件则由下面的
  // dev:ino 比对发现——只看长度发现不了「新文件不比旧文件短」的轮转。
  let descriptor = -1
  /** 当前句柄对应文件的 `dev:ino`，用来识别路径被换成了另一个文件。 */
  let descriptorKey = ''
  let pendingSize = 0
  const closeTarget = () => {
    if (descriptor >= 0) closeSync(descriptor)
    descriptor = -1
    descriptorKey = ''
  }
  /**
   * 对路径取一次 stat：换掉旧句柄、按需打开当前文件，并把长度记进
   * `pendingSize`。返回读取位置与半条尾巴是否需要复位。
   *
   * 必须在 `tail.poll()` **之前**调用：轮转一旦发现就要在同一轮里复位读取
   * 位置，否则新文件会被当成旧文件的续写，从旧偏移读起。
   */
  const checkTarget = () => {
    let stats
    try {
      stats = statSync(target)
    } catch {
      // 路径不在了：旧句柄指的是已删除的 inode，留着它只会让「新文件恰好
      // 复用同一 inode」被误判成没换过。丢掉句柄并要求复位。
      closeTarget()
      pendingSize = 0
      return true
    }
    const key = `${stats.dev}:${stats.ino}`
    const rotated = descriptor >= 0 && key !== descriptorKey
    if (rotated) closeTarget()
    if (descriptor < 0) {
      descriptor = openSync(target, 'r')
      descriptorKey = key
    }
    pendingSize = stats.size
    return rotated
  }
  // checkTarget 每次 poll 都先跑，所以读的时候句柄必定是开的；这里不再兜底
  // 打开——那样开出的句柄没有记下 `descriptorKey`，下一次 checkTarget 会把
  // 同一个文件误判成轮转。
  const readRange = (offset, length) => {
    const buffer = Buffer.allocUnsafe(length)
    const got = readSync(descriptor, buffer, 0, length, offset)
    return buffer.toString('utf8', 0, got)
  }
  // 长度由 checkTarget 本次 stat 的结果给出：一次回调只 stat 一次，轮转判定
  // 与实际读取看到的必然是同一份状态。
  const tail = createIncrementalTail({ read: readRange, size: () => pendingSize })
  const poll = () => {
    try {
      if (checkTarget()) tail.reset()
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
