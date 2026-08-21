/**
 * 图片粘贴增强回归（feat/image-paste-enhancements）：
 *   1. imageDimensions 纯函数头解析：合成 PNG IHDR / JPEG SOF 头的精确
 *      尺寸读出、损坏头返回 undefined
 *   2. 拖拽路径适配：bracketed paste 单一图片绝对路径 → channel.stageImage
 *      被调用且 token 插入输入框；普通文本粘贴保持原样插入
 *   3. shrinkImageToLimits 降级路径：sharp 缺席时未超限数据原样返回、
 *      超限数据也原样返回（服务端严格准入兜底）；sharp 在场时的真实
 *      缩放分支仅在安装了 sharp 的环境执行
 * 运行：node --import tsx/esm scripts/verify-image-paste.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
])
const { render, Box, Text } = await import('../src/ui.js')
const { PromptInput } = await import('../src/components/PromptInput.js')
const { imageDimensions, shrinkImageToLimits } = await import('../src/utils/imageResize.js')

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) process.stdout.write(`PASS  ${name}\n`)
  else { failures++; process.stdout.write(`FAIL  ${name} — ${detail}\n`) }
}

// ── 1. imageDimensions 头解析 ──────────────────────────────────────────────
{
  // PNG：签名 + IHDR + 4BE 宽高
  const png = new Uint8Array(24)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(png.buffer)
  view.setUint32(16, 2560); view.setUint32(20, 1600)
  const got = imageDimensions(png, 'image/png')
  check('PNG IHDR 尺寸 (2560×1600)', got?.width === 2560 && got?.height === 1600, JSON.stringify(got))
  check('PNG 损坏头 undefined', imageDimensions(new Uint8Array(24), 'image/png') === undefined)

  // JPEG：FFD8 + 一个 APP0 段 + SOF0 段（含 2BE 高宽）
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,               // APP0 len=4
    0xff, 0xc0, 0x00, 0x11, 0x08,                     // SOF0 len=17 precision=8
    0x07, 0xd0,                                       // height=2000
    0x0b, 0x40,                                       // width=2880
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
  const gotJ = imageDimensions(jpeg, 'image/jpeg')
  check('JPEG SOF 尺寸 (2880×2000)', gotJ?.width === 2880 && gotJ?.height === 2000, JSON.stringify(gotJ))
  check('非 png/jpeg 类型 undefined', imageDimensions(png, 'image/webp') === undefined)
}

// ── 3. shrink 降级路径（本环境无 sharp 即为降级验证）──────────────────────
{
  const limits = { maxImageBytes: 5 * 1024 * 1024, maxImageDimension: 2000 }
  const png = new Uint8Array(64)
  png.set([0x89, 0x50, 0x4e, 0x47], 0)
  new DataView(png.buffer).setUint32(16, 640); new DataView(png.buffer).setUint32(20, 480)
  const r1 = await shrinkImageToLimits(png, 'image/png', limits)
  check('未超限：原样返回且带尺寸', !r1.shrunk && r1.data === png && r1.width === 640 && r1.height === 480,
    `shrunk=${r1.shrunk} ${r1.width}x${r1.height}`)
  new DataView(png.buffer).setUint32(16, 4000) // 单边 4000 > 2000
  const r2 = await shrinkImageToLimits(png, 'image/png', limits)
  if (r2.shrunk) {
    check('超限 + sharp 在场：等比缩进单边限', Math.max(r2.width, r2.height) <= 2000, `${r2.width}x${r2.height}`)
  } else {
    check('超限 + sharp 缺席：原样返回（服务端准入兜底）', r2.data === png, 'data changed')
  }
}

// ── 2. 拖拽路径端到端 ──────────────────────────────────────────────────────
{
  const staged: Array<{ mediaType: string; name?: string }> = []
  const channel = {
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    commandList: [], commandCompletions: () => [], notifications: [], pending: [], working: false,
    notify() {}, submit() {}, steer() {}, interruptAndDeliver() {}, removePending() {},
    stageImage(input: { mediaType: string; name?: string }): Promise<string> {
      staged.push({ mediaType: input.mediaType, name: input.name })
      return Promise.resolve('[Image #1 (2560×1600)]')
    },
    listFiles: async () => [],
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-img-'))
  const pngPath = join(dir, 'screenshot.png')
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  const COLS = 100, ROWS = 30
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS; rows = ROWS; isTTY = true
    _write(c: unknown, _e: Buffer.Encoding, cb: () => void) { term.write(String(c), cb) }
  }
  class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  const stdin = new FakeStdin()
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const App = () =>
    React.createElement(Box, { flexDirection: 'column', height: ROWS, width: '100%' },
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' }),
      React.createElement(Box, { flexDirection: 'column', flexShrink: 0 },
        React.createElement(PromptInput, { channel, helpOpen: false, onToggleHelp() {}, onRunCommand: () => false, selectionActive: false }),
        React.createElement(Text, null, 'STATUSLINE')))
  await render(React.createElement(App), {
    stdout: new FakeStdout() as never, stdin: stdin as never,
    stderr: new Writable() as never, exitOnCtrlC: false, patchConsole: false,
  })
  await sleep(400)

  stdin.write(`\x1b[200~${pngPath}\x1b[201~`) // kitty 拖拽：路径以括号粘贴到达
  await sleep(500)
  let lines = Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  check('拖拽图片路径：stageImage 收到 image/png + 文件名',
    staged.length === 1 && staged[0]!.mediaType === 'image/png' && staged[0]!.name === 'screenshot.png',
    JSON.stringify(staged))
  check('拖拽图片路径：token 插入输入框', lines.some(l => l.includes('[Image #1 (2560×1600)]')),
    lines.find(l => l.includes('Image')) ?? '(none)')

  stdin.write(`\x1b[200~file://${pngPath}\x1b[201~`) // file:// URI 形态
  await sleep(400)
  check('file:// URI 拖拽形态：同样走图片管道', staged.length === 2 && staged[1]!.mediaType === 'image/png', `staged=${staged.length}`)
  // 上一轮已插入 token；用退格清不干净也无妨——断言只看新 paste 的语义。

  stdin.write('\x1b[200~plain text paste\x1b[201~')
  await sleep(400)
  lines = Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  check('普通文本粘贴：原样插入（不走图片管道）', staged.length === 2 && lines.some(l => l.includes('plain text paste')),
    `staged=${staged.length}`)

  stdin.write('\x1b[200~/nonexistent/dir/x.png\x1b[201~')
  await sleep(400)
  lines = Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  check('不存在的图片路径：退回文本插入', staged.length === 2 && lines.some(l => l.includes('/nonexistent/dir/x.png')),
    `staged=${staged.length}`)
}

if (failures > 0) {
  process.stdout.write(`verify-image-paste: ${failures} assertion(s) failed\n`)
  process.exit(1)
}
process.stdout.write('verify-image-paste OK\n')
