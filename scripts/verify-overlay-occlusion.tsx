/**
 * verify-overlay-occlusion — OverlayAbove 条件表面契约（occlusionColor）：
 *
 *   A. 无终端图像时浮层保持终端透明——整帧不得出现任何 48;2 真彩背景
 *      （49f7166 的恒定 toolCardBackground 表面曾把每个瞬态面板画成
 *      整块高亮）。
 *   B. 浮层矩形与就绪的 Kitty placement 相交时必须涂非默认背景盖住
 *      negative-z 图像，且不得引起 graphics 协议扰动（a=[dpt]）。
 *      B/C/D 断言落到 headless 终端的单元格状态：B 相交区域每个
 *      单元格非默认背景（涂满，不是只出现一处 SGR）；C/D 该区域
 *      恢复默认背景、菜单文本清除。
 *   C. 图像在旁、浮层不与其相交 → 仍然透明（区域精确性）。
 *   D. 覆盖关闭 → 无 graphics 扰动，相交区域恢复默认背景。
 *   E. 浮层打开期间图像才就绪（浮层子树干净、走 blit 恢复旧透明
 *      单元格）→ 帧末 mismatch 检查必须安排补绘帧，图像就绪后
 *      遮挡背景自动出现，无需任何交互；关闭同样恢复默认。
 *
 * 夹具形状注意：Text 必须包在自己的 Box 里——裸 Text 与包含绝对定位
 * 浮层锚点的列容器同层时整帧不绘（移植渲染器既有怪癖，与本契约无关）。
 *
 * 运行：node --import tsx/esm scripts/verify-overlay-occlusion.tsx
 */
process.env.FORCE_COLOR = '3'

import assert from 'node:assert/strict'
import chalk from 'chalk'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { OverlayAbove } from '../src/components/OverlayAbove.js'
import { AlternateScreen, Box, Image, render, Text } from '../src/ui.js'
import {
  kittyGraphics,
  terminalCellSizePixels,
  terminalWindowSizePixels,
} from '../src/ink/terminal-querier.js'
import { settled } from './lib/term-test.mjs'

// @xterm/headless 的 CJS 互操作没有具名 ESM 导出——仓库脚本一律动态
// import 取 Terminal（bench-yoga、probe 系列同款）。
const { Terminal: XTerm } = await import('@xterm/headless')

const source = {
  data: new Uint8Array(40 * 40 * 4).fill(127),
  width: 40,
  height: 40,
}

// ESM 静态 import 先于顶部 env 赋值求值——chalk 在 NO_COLOR 环境里会以
// level 0 载入，applyTextStyles 剥掉全部 SGR，48;2 断言必然假阴性。
chalk.level = 3

const query = kittyGraphics(31)
const cellSizeQuery = terminalCellSizePixels()
const windowSizeQuery = terminalWindowSizePixels()

class FakeStdout extends Writable {
  columns = 40
  rows = 8
  isTTY = true
  output = ''
  term: InstanceType<typeof XTerm> | undefined
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    const text = String(chunk)
    this.output += text
    this.term?.write(text)
    cb()
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

const previousEnv = {
  tmux: process.env.TMUX,
  sty: process.env.STY,
  disabled: process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES,
}
delete process.env.TMUX
delete process.env.STY
delete process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES

const options = (stdout: FakeStdout, stdin: FakeStdin) => ({
  stdin,
  stdout,
  stderr: new FakeStderr(),
  exitOnCtrlC: false,
  patchConsole: false,
})

const TRUECOLOR_BACKGROUND = /\x1b\[48;2;\d+;\d+;\d+m/u

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function cellsHaveBackground(
  term: InstanceType<typeof XTerm>,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  for (let row = y; row < y + height; row++) {
    const line = term.buffer.active.getLine(row)
    if (!line) return false
    for (let col = x; col < x + width; col++) {
      const cell = line.getCell(col)
      if (!cell || cell.isBgDefault() || cell.isBgPalette()) return false
    }
  }
  return true
}

function cellsBackgroundDefault(
  term: InstanceType<typeof XTerm>,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  for (let row = y; row < y + height; row++) {
    const line = term.buffer.active.getLine(row)
    if (!line) return false
    for (let col = x; col < x + width; col++) {
      const cell = line.getCell(col)
      if (!cell || (!cell.isBgDefault() && !cell.isBgPalette())) return false
    }
  }
  return true
}

function rowText(term: InstanceType<typeof XTerm>, y: number): string {
  const line = term.buffer.active.getLine(y)
  return line ? (line.translateToString(true) ?? '') : ''
}

// ─── A. 无图像 → 浮层透明 ─────────────────────────────────────────────
{
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const treeA = (
    <AlternateScreen>
      <Box width={4} height={4} flexDirection="column">
        <Box width={4} height={2}>
          <Text>{'base'}</Text>
        </Box>
        <Box width={4} height={2}>
          <OverlayAbove>
            <Box width={4} height={2}>
              <Text>{'menu'}</Text>
            </Box>
          </OverlayAbove>
        </Box>
      </Box>
    </AlternateScreen>
  )
  const instance = await render(treeA, options(stdout, stdin))
  instance.rerender(treeA)
  assert.ok(
    await settled(() => stdout.output.includes('menu')),
    'A: overlay content must render',
  )
  assert.doesNotMatch(
    stdout.output,
    TRUECOLOR_BACKGROUND,
    'A: image-free overlays must stay terminal-transparent (no truecolor background)',
  )
  stdout.isTTY = false
  instance.unmount()
}

// ─── B/C/D. 图像在场：覆盖 → 涂底；不覆盖 → 透明；关闭 → 无扰动 ────────
{
  const term = new XTerm({ cols: 40, rows: 8, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout()
  stdout.term = term
  const stdin = new FakeStdin()
  // 根 4x6：Image 行 0-1；anchor1 行 2-3（covering 浮层高 4 → 行 -2..1，
  // 可见行 0-1 覆盖图像）；anchor2 行 4-5（beside 浮层高 2 → 行 2-3，
  // 与图像不相交）。
  const tree = (overlay: 'covering' | 'beside' | null) => (
    <AlternateScreen>
      <Box width={4} height={6} flexDirection="column">
        <Image source={source} width={4} height={2} alt="cover art">
          <Text>{'####\n####'}</Text>
        </Image>
        <Box width={4} height={2}>
          {overlay === 'covering' ? (
            <OverlayAbove>
              <Box width={4} height={4} flexDirection="column">
                <Box width={4} height={2} />
                <Box width={4} height={2}>
                  <Text>{'menu'}</Text>
                </Box>
              </Box>
            </OverlayAbove>
          ) : null}
        </Box>
        <Box width={4} height={2}>
          {overlay === 'beside' ? (
            <OverlayAbove>
              <Box width={4} height={2}>
                <Text>{'side'}</Text>
              </Box>
            </OverlayAbove>
          ) : null}
        </Box>
      </Box>
    </AlternateScreen>
  )
  const instance = await render(tree(null), options(stdout, stdin))
  instance.rerender(tree(null))
  assert.ok(
    await settled(() => stdout.output.includes('####')),
    'fallback cells must render before the Kitty probe completes',
  )
  assert.ok(
    await settled(
      () =>
        stdout.output.includes(query.request) &&
        stdout.output.includes(cellSizeQuery.request) &&
        stdout.output.includes(windowSizeQuery.request),
    ),
    'the image must trigger the Kitty capability batch',
  )
  stdin.write(
    '\x1b_Gi=31;OK\x1b\\' +
    '\x1b[6;20;10t\x1b[4;160;400t' +
    '\x1b[?61;4c\x1b[?61;4c\x1b[?61;4c',
  )
  assert.ok(
    await settled(() => stdout.output.includes('a=p,i=')),
    'the ready image must be placed',
  )

  // B: 覆盖图像的浮层 → 非默认背景，且无 graphics 扰动
  const beforeCover = stdout.output.length
  instance.rerender(tree('covering'))
  assert.ok(
    await settled(() => stdout.output.slice(beforeCover).includes('menu')),
    'the covering overlay must finish painting',
  )
  const coverSlice = stdout.output.slice(beforeCover)
  assert.match(
    coverSlice,
    TRUECOLOR_BACKGROUND,
    'B: an overlay covering a ready image must paint a non-default background',
  )
  assert.doesNotMatch(
    coverSlice,
    /\x1b_Ga=[dpt],/u,
    'B: covering an image must not delete, retransmit, or replace its placement',
  )
  assert.ok(
    cellsHaveBackground(term, 0, 0, 4, 2),
    'B: every overlay cell intersecting the image must carry the cover background',
  )

  // C: 图像在旁（矩形不相交）→ 仍然透明
  const beforeBeside = stdout.output.length
  instance.rerender(tree('beside'))
  assert.ok(
    await settled(() => stdout.output.slice(beforeBeside).includes('side')),
    'the beside overlay must finish painting',
  )
  const besideSlice = stdout.output.slice(beforeBeside)
  assert.doesNotMatch(
    besideSlice,
    TRUECOLOR_BACKGROUND,
    'C: an overlay that does not intersect the image must stay transparent',
  )
  assert.doesNotMatch(
    besideSlice,
    /\x1b_Ga=[dpt],/u,
    'C: moving off the image must not churn graphics',
  )
  assert.ok(
    cellsBackgroundDefault(term, 0, 0, 4, 2),
    'C: cells over the image must return to default once the overlay moves off',
  )

  // D: 关闭浮层 → 无 graphics 扰动
  const beforeClose = stdout.output.length
  instance.rerender(tree(null))
  assert.ok(
    await settled(() => stdout.output.length > beforeClose),
    'closing the overlay must repaint',
  )
  assert.doesNotMatch(
    stdout.output.slice(beforeClose),
    /\x1b_Ga=[dpt],/u,
    'D: closing the overlay must not churn graphics',
  )
  assert.ok(
    cellsBackgroundDefault(term, 0, 0, 4, 2) && !rowText(term, 0).includes('menu'),
    'D: closing the overlay must clear the cover background and the menu text',
  )
  stdout.isTTY = false
  instance.unmount()
}

// ─── E. 图像后到：浮层子树干净时图像才就绪 → 帧末补绘 ─────────────────
{
  const term = new XTerm({ cols: 40, rows: 8, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout()
  stdout.term = term
  const stdin = new FakeStdin()
  // 根 4x6：Image 行 0-1（文档序在前）；'base' 行 2-3；anchor 行 4-5，
  // 覆盖浮层高 4 → 行 0-3。浮层从首帧就打开：图像就绪那一帧浮层子树
  // 是干净的（走 blit 恢复透明单元格），只有帧末 mismatch 检查安排的
  // 补绘帧能把遮挡背景补上——不需要任何用户交互。
  const treeE = (open: boolean) => (
    <AlternateScreen>
      <Box width={4} height={6} flexDirection="column">
        <Image source={source} width={4} height={2} alt="late art">
          <Text>{'####\n####'}</Text>
        </Image>
        <Box width={4} height={2}>
          <Text>{'base'}</Text>
        </Box>
        <Box width={4} height={2}>
          {open ? (
            <OverlayAbove>
              <Box width={4} height={4} flexDirection="column">
                <Box width={4} height={2} />
                <Box width={4} height={2}>
                  <Text>{'menu'}</Text>
                </Box>
              </Box>
            </OverlayAbove>
          ) : null}
        </Box>
      </Box>
    </AlternateScreen>
  )
  const instance = await render(treeE(true), options(stdout, stdin))
  instance.rerender(treeE(true))
  assert.ok(
    await settled(() => stdout.output.includes('menu')),
    'E: the overlay must render before the image is ready',
  )
  assert.ok(
    await settled(
      () =>
        stdout.output.includes(query.request) &&
        stdout.output.includes(cellSizeQuery.request) &&
        stdout.output.includes(windowSizeQuery.request),
    ),
    'E: the image must trigger the Kitty capability batch',
  )
  stdin.write(
    '\x1b_Gi=31;OK\x1b\\' +
    '\x1b[6;20;10t\x1b[4;160;400t' +
    '\x1b[?61;4c\x1b[?61;4c\x1b[?61;4c',
  )
  assert.ok(
    await settled(() => stdout.output.includes('a=p,i=')),
    'E: the late image must be placed',
  )
  assert.ok(
    await settled(() => cellsHaveBackground(term, 0, 0, 4, 2)),
    'E: the cover must appear over the image once it is ready, with no interaction',
  )
  assert.ok(
    rowText(term, 2).includes('menu'),
    'E: the overlay text must stay on top of the covered region',
  )
  const beforeStable = stdout.output.length
  await sleep(150)
  assert.ok(
    cellsHaveBackground(term, 0, 0, 4, 2),
    'E: the cover must stay stable after the corrective frame',
  )
  assert.doesNotMatch(
    stdout.output.slice(beforeStable),
    /\x1b_Ga=[dpt],/u,
    'E: the corrective frame must not churn graphics',
  )
  const beforeClose = stdout.output.length
  instance.rerender(treeE(false))
  assert.ok(
    await settled(
      () =>
        cellsBackgroundDefault(term, 0, 0, 4, 2) &&
        rowText(term, 2).includes('base') &&
        !rowText(term, 2).includes('menu'),
    ),
    'E: closing the overlay must clear the cover and reveal the row beneath',
  )
  assert.doesNotMatch(
    stdout.output.slice(beforeClose),
    /\x1b_Ga=[dpt],/u,
    'E: closing the overlay must not churn graphics',
  )
  stdout.isTTY = false
  instance.unmount()
}

for (const [key, value] of Object.entries(previousEnv)) {
  const envKey =
    key === 'tmux'
      ? 'TMUX'
      : key === 'sty'
        ? 'STY'
        : 'DSH_TUI_DISABLE_TERMINAL_IMAGES'
  if (value === undefined) delete process.env[envKey]
  else process.env[envKey] = value
}

console.log('PASS: overlay surface is conditional — transparent unless covering an image')
