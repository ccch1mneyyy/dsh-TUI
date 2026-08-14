/**
 * conpty 透传探测：pty-target.tsx 在真实 conpty 里渲染 ask 问卷，
 * conpty 重编码后的字节流喂给 xterm-headless 重建屏幕，断言面板完整。
 * 运行：node scripts/pty-conpty-probe.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// node-pty 是原生模块，不进本仓库依赖：DSH_CC_NODE_PTY 指向已构建的
// node-pty 目录（含 package.json 的那层），否则尝试常规 require。
const PTY = process.env.DSH_CC_NODE_PTY ?? 'node-pty'
const pty = require(PTY)
const { Terminal } = require('@xterm/headless')

const COLS = 160, ROWS = 50
const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'scripts/pty-target.tsx'], {
  cols: COLS, rows: ROWS, cwd: process.cwd(), useConpty: true,
})
let raw = ''
child.onData(d => { raw += d })
const code = await new Promise(r => child.onExit(r))
// conpty 重编码字节 → xterm 重建屏幕
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
term.write(raw)
await new Promise(r => setTimeout(r, 500))
const buf = term.buffer.active
const screen = Array.from({ length: ROWS }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '').join('\n')
const REQUIRED = ['随便问问 2', '再测一次', '宅家打游戏/看剧', '出去浪一圈', '学习或写代码', '纯躺平休息', '很有成就感', '换换脑子', '卷王本王', '睡到自然醒', '自定义回答', '↑/↓ 选择', 'Esc 中断']
const missing = REQUIRED.filter(t => !screen.includes(t))
console.log('exit:', JSON.stringify(code))
if (missing.length === 0) {
  console.log('conpty 透传后屏幕完整 — ALL PRESENT')
} else {
  console.log('conpty 透传后缺失:', missing.join(' / '))
  console.log('--- 屏幕最后 22 行 ---')
  screen.split('\n').slice(-22).forEach((line, i) => console.log(String(ROWS - 22 + i).padStart(3) + ' |' + line))
}
process.exit(missing.length === 0 ? 0 : 1)
