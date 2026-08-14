/**
 * conpty 增量透传压力探测（issue #16/#10）：pty-target-stream.tsx 在真实
 * conpty 里做多帧流式渲染 + 中途弹问卷，conpty 重编码后的字节流喂给
 * xterm-headless 重建屏幕，断言问卷面板完整、无行缺失。
 * 与 pty-conpty-probe.mjs（静态一帧）互补，针对增量 diff 序列的保真度。
 * 运行：node scripts/pty-conpty-stress.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const PTY = process.env.DSH_CC_NODE_PTY ?? 'node-pty'
const pty = require(PTY)
const { Terminal } = require('@xterm/headless')

const COLS = 160, ROWS = 50
const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'scripts/pty-target-stream.tsx'], {
  cols: COLS, rows: ROWS, cwd: process.cwd(), useConpty: true,
})
let raw = ''
child.onData(d => { raw += d })
const code = await new Promise(r => child.onExit(r))
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
term.write(raw)
await new Promise(r => setTimeout(r, 800))
const buf = term.buffer.active
const total = buf.length
const lines = Array.from({ length: total }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '')
const viewport = lines.slice(Math.max(0, total - ROWS))
const screen = viewport.join('\n')

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// 问卷面板完整性（与静态探测同一组要素）。
const REQUIRED = ['随便问问 2', '再测一次', '宅家打游戏/看剧', '出去浪一圈', '学习或写代码', '纯躺平休息', '很有成就感', '换换脑子', '卷王本王', '睡到自然醒', '自定义回答', '↑/↓ 选择', 'Esc 中断']
const missing = REQUIRED.filter(t => !screen.includes(t))
check('问卷面板经增量透传后完整', missing.length === 0, missing.length ? `缺失: ${missing.join(' | ')}` : '')

// 视口内问卷要素无重复（残影会让 label 出现两次）。
for (const t of ['随便问问 2', '宅家打游戏/看剧', '睡到自然醒']) {
  const n = viewport.filter(l => l.includes(t)).length
  check(`「${t}」视口内至多一次`, n <= 1, `实际 ${n}`)
}

console.log('exit:', JSON.stringify(code), ' buffer 总行数:', total, ' scrollback:', total - ROWS)
if (failed > 0) {
  console.log('=== 视口 ===')
  viewport.forEach((l, y) => console.log(`${String(y).padStart(3)}|${l}`))
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
