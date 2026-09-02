/** Kitty graphics protocol, fallback, placement, and lifecycle regression. */

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import chalk from 'chalk'
import React from 'react'
import { OverlayAbove } from '../src/components/OverlayAbove.js'
import {
  PromptEditorLayer,
  setPromptEditorNode,
} from '../src/components/PromptEditor.js'
import { AlternateScreen, Box, Image, render, Text } from '../src/ui.js'
import { createNode } from '../src/ink/dom.js'
import instances from '../src/ink/instances.js'
import {
  KittyGraphicsManager,
  transmitKittyRgba,
} from '../src/ink/kitty-graphics.js'
import Output from '../src/ink/output.js'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
} from '../src/ink/parse-keypress.js'
import {
  CharPool,
  cellAt,
  createScreen,
  HyperlinkPool,
  isEmptyCellAt,
  type Screen,
  StylePool,
} from '../src/ink/screen.js'
import { kittyGraphics } from '../src/ink/terminal-querier.js'
import {
  isTerminalImageSource,
  TERMINAL_IMAGE_MAX_FRAME_BYTES,
  type TerminalImagePlacement,
  type TerminalImageSource,
} from '../src/ink/terminal-image.js'
import { settled } from './lib/term-test.mjs'

const source: TerminalImageSource = {
  data: new Uint8Array(40 * 40 * 4).fill(127),
  width: 40,
  height: 40,
}

const previousChalkLevel = chalk.level
chalk.level = 3

assert.equal(isTerminalImageSource(source), true)
assert.equal(
  isTerminalImageSource({ ...source, data: source.data.subarray(1) }),
  false,
  'RGBA byte length must match dimensions exactly',
)

const transmission = transmitKittyRgba(101, source)
const chunks = [...transmission.matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/gu)]
assert.ok(chunks.length > 1, 'large RGBA payload must be chunked')
assert.ok(chunks.every(match => match[2]!.length <= 4096))
assert.match(chunks[0]![1]!, /a=t,t=d,f=32,s=40,v=40,i=101/u)
assert.doesNotMatch(
  transmission,
  /\x1b_Ga=T,/u,
  'upload must not create an implicit natural-size placement',
)
assert.ok(chunks.slice(1).every(match => !match[1]!.includes('f=32')))

const guardedPixels = new Uint8Array([9, 1, 2, 3, 4, 9])
const subarrayTransmission = transmitKittyRgba(102, {
  data: guardedPixels.subarray(1, 5),
  width: 1,
  height: 1,
})
const subarrayPayload = [
  ...subarrayTransmission.matchAll(/\x1b_G[^;]+;([^\x1b]*)\x1b\\/gu),
].map(match => match[1]!).join('')
assert.deepEqual(
  Buffer.from(subarrayPayload, 'base64'),
  Buffer.from([1, 2, 3, 4]),
  'zero-copy encoding must stay within the Uint8Array view boundaries',
)

const node = createNode('ink-image')
const manager = new KittyGraphicsManager({ firstImageId: 101 })
const placement = {
  node,
  x: 2,
  y: 3,
  columns: 6,
  rows: 3,
  source,
}
const first = manager.reconcile([placement])
assert.match(first, /a=t,t=d,f=32/u)
assert.match(first, /a=p,i=101,p=1,c=6,r=3,z=-2147483648,C=1/u)
assert.match(
  first,
  /\x1b\[4;3H\x1b_Ga=p,i=101,p=1,c=6,r=3,z=-2147483648,C=1,q=2;/u,
  'the sole display action must follow the target-cell cursor placement',
)
assert.equal(
  [...first.matchAll(/\x1b_Ga=p,/gu)].length,
  1,
  'one image request must create exactly one placement',
)
assert.ok(
  first.indexOf('\x1b_Ga=t,') < first.indexOf('\x1b[4;3H\x1b_Ga=p,'),
  'all image data must be uploaded before the sole placement is created',
)
assert.equal(manager.reconcile([placement]), '', 'stable frame must emit no graphics bytes')
const moved = manager.reconcile([{ ...placement, x: 4 }])
assert.doesNotMatch(moved, /\x1b_Ga=[tT],/u)
assert.match(moved, /a=p,i=101,p=1,c=6,r=3,z=-2147483648,C=1/u)
const replacementData = source.data.slice()
replacementData[0] ^= 0xff
const replacementPlacement = {
  ...placement,
  x: 4,
  source: { ...source, data: replacementData },
}
const replaced = manager.reconcile([replacementPlacement])
assert.match(
  replaced,
  /a=t,t=d,f=32/u,
  'same-size changed pixels in a new immutable buffer must upload again',
)
const replacementImageId = /a=t,t=d,f=32,[^;]*i=(\d+)/u.exec(replaced)?.[1]
assert.ok(replacementImageId, 'replacement upload must carry an image id')
assert.match(
  replaced,
  new RegExp(`a=p,i=${replacementImageId},p=1,c=6,r=3,z=-2147483648,C=1`, 'u'),
)
assert.equal(
  manager.reconcile([replacementPlacement]),
  '',
  'reusing the same immutable pixel snapshot must not upload again',
)
manager.invalidateAll()
const invalidated = manager.reconcile([replacementPlacement])
assert.match(invalidated, /a=t,t=d,f=32/u)
assert.equal([...invalidated.matchAll(/\x1b_Ga=p,/gu)].length, 1)
assert.match(
  invalidated,
  new RegExp(`a=p,i=${replacementImageId},p=1,c=6,r=3,z=-2147483648,C=1`, 'u'),
)
assert.match(manager.reconcile([]), new RegExp(`a=d,d=I,i=${replacementImageId}`, 'u'))

const query = kittyGraphics(31)
assert.equal(query.request, '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\')
const [parsed] = parseMultipleKeypresses(
  INITIAL_STATE,
  '\x1b_Gi=31;OK\x1b\\',
)
assert.equal(parsed[0]?.kind, 'response')
if (parsed[0]?.kind !== 'response') throw new Error('Kitty reply was not parsed')
assert.deepEqual(parsed[0].response, {
  type: 'kittyGraphics',
  imageId: 31,
  status: 'OK',
})
assert.equal(query.match(parsed[0].response), true)

const stylePool = new StylePool()
const screen = createScreen(
  12,
  6,
  stylePool,
  new CharPool(),
  new HyperlinkPool(),
)
const output = new Output({ width: 12, height: 6, stylePool, screen })
output.clip({ x1: 2, x2: 8, y1: 1, y2: 4 })
assert.equal(output.image(node, 2, 1, 6, 3, source), true)
assert.equal(output.image(createNode('ink-image'), 1, 1, 6, 3, source), false)
assert.equal(output.image(createNode('ink-image'), 0, 0, 32, 17, source), false)
output.unclip()
assert.equal(output.getImages().length, 1)
const root = createNode('ink-box')
node.parentNode = root
const reused = new Output({
  width: 12,
  height: 6,
  stylePool,
  screen: createScreen(12, 6, stylePool, new CharPool(), new HyperlinkPool()),
  previousImages: [placement],
})
reused.reuseImages(root)
assert.equal(
  reused.getImages().length,
  1,
  'a clean ancestor blit must retain descendant placements',
)
node.parentNode = undefined

const maximalSource: TerminalImageSource = {
  data: new Uint8Array(1024 * 1024 * 4),
  width: 1024,
  height: 1024,
}
assert.equal(
  maximalSource.data.byteLength * 4,
  TERMINAL_IMAGE_MAX_FRAME_BYTES,
  'the frame budget must admit four maximum-sized sources',
)
const budgetOutput = new Output({
  width: 8,
  height: 2,
  stylePool,
  screen: createScreen(8, 2, stylePool, new CharPool(), new HyperlinkPool()),
  terminalImages: true,
})
assert.deepEqual(
  Array.from({ length: 5 }, (_, index) =>
    budgetOutput.image(
      createNode('ink-image'),
      index,
      0,
      1,
      1,
      maximalSource,
    ),
  ),
  [true, true, true, true, false],
  'the fifth maximum-sized placement must exceed the decoded frame budget',
)

const fallbackScrollOutput = new Output({
  width: 12,
  height: 6,
  stylePool,
  screen: createScreen(12, 6, stylePool, new CharPool(), new HyperlinkPool()),
  terminalImages: false,
  previousImages: [placement],
})
assert.equal(
  fallbackScrollOutput.hasPreviousImageInRegion(0, 0, 12, 6),
  false,
  'inline and unsupported fallbacks must not disable the terminal scroll fast path',
)
const graphicsScrollOutput = new Output({
  width: 12,
  height: 6,
  stylePool,
  screen: createScreen(12, 6, stylePool, new CharPool(), new HyperlinkPool()),
  terminalImages: true,
  previousImages: [placement],
})
assert.equal(
  graphicsScrollOutput.hasPreviousImageInRegion(0, 0, 12, 6),
  true,
  'active terminal placements must still fence the scroll fast path',
)

class FakeStdout extends Writable {
  columns = 40
  rows = 8
  isTTY = true
  output = ''

  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.output += String(chunk)
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true

  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled
    return this
  }

  override ref(): this {
    return this
  }

  override unref(): this {
    return this
  }
}

const previousEnv = {
  tmux: process.env.TMUX,
  sty: process.env.STY,
  accessibility: process.env.CLAUDE_CODE_ACCESSIBILITY,
  disabled: process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES,
}
delete process.env.TMUX
delete process.env.STY
delete process.env.CLAUDE_CODE_ACCESSIBILITY
delete process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const imageTree = (
  covered: boolean,
  coloredParent = false,
): React.ReactElement => (
  <AlternateScreen>
    <Box
      width={4}
      height={4}
      flexDirection="column"
      {...(coloredParent ? { backgroundColor: '#123456' as const } : {})}
    >
      <Image source={source} width={4} height={2} alt="cover art">
        <Text>{'▓▓▓▓\n▓▓▓▓'}</Text>
      </Image>
      <Box width={4} height={2}>
        {covered ? (
          <OverlayAbove>
            <Box width={4} height={2}>
              <Text>{'menu'}</Text>
            </Box>
          </OverlayAbove>
        ) : null}
      </Box>
    </Box>
  </AlternateScreen>
)
const budgetTree = (withLeadingImage: boolean): React.ReactElement => (
  <AlternateScreen>
    <Box width={6} height={2} flexDirection="row">
      {withLeadingImage ? (
        <Box
          key="leading"
          position="absolute"
          top={0}
          left={5}
          width={1}
          height={1}
        >
          <Image source={maximalSource} width={1} height={1} alt="leading">
            <Text>X</Text>
          </Image>
        </Box>
      ) : null}
      <Box key="stable" width={4} height={1} flexDirection="row">
        {(['A', 'B', 'C', 'D'] as const).map(label => (
          <Image
            key={label}
            source={maximalSource}
            width={1}
            height={1}
            alt={label}
          >
            <Text>{label}</Text>
          </Image>
        ))}
      </Box>
    </Box>
  </AlternateScreen>
)
const tree = imageTree(false)
const instance = await render(tree, {
  stdin,
  stdout,
  stderr: new FakeStderr(),
  exitOnCtrlC: false,
  patchConsole: false,
})
instance.rerender(tree)
assert.ok(
  await settled(() => stdout.output.includes('▓▓▓▓')),
  'fallback cells must render before capability succeeds',
)
assert.ok(
  await settled(() => stdout.output.includes(query.request)),
  'a laid-out fullscreen image must trigger one Kitty query',
)
stdin.write('\x1b_Gi=31;OK\x1b\\\x1b[?61;4c\x1b[?61;4c\x1b[?61;4c')
assert.ok(
  await settled(
    () =>
      stdout.output.includes('a=t,t=d,f=32') &&
      stdout.output.includes('a=p,i='),
  ),
  'a successful query must upload and place RGBA pixels',
)
const ink = instances.get(stdout)
assert.ok(ink, 'the rendered tree must retain its Ink instance')
const inkState = ink as unknown as {
  readonly frontFrame: {
    readonly images?: readonly TerminalImagePlacement[]
    readonly screen: Screen
  }
  readonly kittyGraphicsManager: KittyGraphicsManager
}

const beforeColoredParent = stdout.output.length
instance.rerender(imageTree(false, true))
assert.ok(
  await settled(() => stdout.output.length > beforeColoredParent),
  'adding a colored parent must repaint the image row',
)
const coloredScreen = inkState.frontFrame.screen
assert.equal(
  isEmptyCellAt(coloredScreen, 0, 0),
  true,
  'image-owned cells must clear an inherited non-default background',
)
assert.equal(
  isEmptyCellAt(coloredScreen, 0, 2),
  false,
  'clearing the image backing must not erase the surrounding parent surface',
)

const beforeOcclusion = stdout.output.length
instance.rerender(imageTree(true, true))
assert.ok(
  await settled(() => stdout.output.slice(beforeOcclusion).includes('menu')),
  'the image-covering overlay must finish painting before its styles are checked',
)
const occlusionOutput = stdout.output.slice(beforeOcclusion)
assert.match(
  occlusionOutput,
  /\x1b\[48;2;\d+;\d+;\d+m/u,
  'a shared overlay must paint a non-default background that covers negative-z Kitty graphics',
)
assert.doesNotMatch(
  occlusionOutput,
  /\x1b_Ga=[dpt],/u,
  'covering an image must not delete, retransmit, or replace its stable placement',
)
const beforeUncover = stdout.output.length
instance.rerender(imageTree(false, true))
assert.ok(
  await settled(() => stdout.output.length > beforeUncover),
  'closing the image-covering overlay must repaint its cells',
)
assert.doesNotMatch(
  stdout.output.slice(beforeUncover),
  /\x1b_Ga=[dpt],/u,
  'closing an overlay must reveal the stable placement without protocol churn',
)

setPromptEditorNode(<Text>editor cover</Text>)
const beforeEditorCover = stdout.output.length
instance.rerender(
  <AlternateScreen>
    <Box width={4} height={4} flexDirection="column">
      <Image source={source} width={4} height={2} alt="cover art" />
    </Box>
    <PromptEditorLayer />
  </AlternateScreen>,
)
assert.ok(
  await settled(() => stdout.output.slice(beforeEditorCover).includes('editor cover')),
  'the fullscreen prompt editor must paint above terminal images',
)
assert.match(
  stdout.output.slice(beforeEditorCover),
  /\x1b\[48;2;\d+;\d+;\d+m/u,
  'the fullscreen prompt editor must use a non-default background surface',
)
assert.doesNotMatch(
  stdout.output.slice(beforeEditorCover),
  /\x1b_Ga=[dpt],/u,
  'covering the screen must not delete or retransmit a stable image',
)
const editorScreen = inkState.frontFrame.screen
for (let y = 0; y < 2; y++) {
  for (let x = 0; x < 4; x++) {
    assert.notEqual(
      cellAt(editorScreen, x, y)?.styleId,
      editorScreen.emptyStyleId,
      `the fullscreen editor must cover image cell ${x},${y}`,
    )
  }
}
setPromptEditorNode(null)

// Reordering the 16 MiB budget must repaint a former image as fallback,
// not blit the default-background cells that sat behind its old placement.
// Stub protocol reconciliation here: the renderer behavior is under test,
// and base64-encoding four shared 4 MiB sources would add no coverage.
const graphicsManager = inkState.kittyGraphicsManager
const reconcileGraphics = graphicsManager.reconcile
graphicsManager.reconcile = () => ''
try {
  instance.rerender(budgetTree(false))
  assert.ok(
    await settled(
      () =>
        inkState.frontFrame.images?.length === 4 &&
        inkState.frontFrame.images.every(
          image => image.source.data === maximalSource.data,
        ),
    ),
    'the first budget frame must place all four stable images',
  )
  const firstBudgetFrame = inkState.frontFrame
  instance.rerender(budgetTree(true))
  assert.ok(
    await settled(() => inkState.frontFrame !== firstBudgetFrame),
    'inserting the leading image must produce a second budget frame',
  )
  assert.equal(
    inkState.frontFrame.images?.length,
    4,
    'the second frame must remain within the decoded image budget',
  )
  assert.equal(
    cellAt(inkState.frontFrame.screen, 3, 0)?.char,
    'D',
    'a clean image displaced from the budget must repaint its fallback',
  )
} finally {
  graphicsManager.reconcile = reconcileGraphics
}

const beforeFallbackRestore = stdout.output.length
const fallbackTree = (
  <AlternateScreen>
    <Image source={undefined} width={4} height={2} alt="cover art">
      <Text>{'▓▓▓▓\n▓▓▓▓'}</Text>
    </Image>
  </AlternateScreen>
)
instance.rerender(fallbackTree)
assert.ok(
  await settled(
    () =>
      stdout.output.slice(beforeFallbackRestore).includes('▓▓▓▓') &&
      stdout.output.slice(beforeFallbackRestore).includes('a=d,d=I,i='),
  ),
  'removing a source must restore fallback cells and delete its image',
)
const beforeRestore = stdout.output.length
instance.rerender(tree)
assert.ok(
  await settled(() => stdout.output.slice(beforeRestore).includes('a=t,t=d,f=32')),
  'restoring a source must upload it again',
)
const beforeHandoff = stdout.output.length
ink.enterAlternateScreen()
const handoffOutput = stdout.output.slice(beforeHandoff)
const handoffDeleteAt = handoffOutput.indexOf('a=d,d=I,i=')
const handoffClearAt = handoffOutput.indexOf('\x1b[2J')
assert.ok(
  handoffDeleteAt >= 0 && handoffDeleteAt < handoffClearAt,
  'external-editor handoff must delete Kitty images before clearing its screen',
)
const beforeHandoffRestore = stdout.output.length
ink.exitAlternateScreen()
assert.ok(
  await settled(
    () => {
      const restored = stdout.output.slice(beforeHandoffRestore)
      return restored.includes('a=t,t=d,f=32') && restored.includes('a=p,i=')
    },
  ),
  'returning from an external editor must upload and place visible images again',
)
stdout.isTTY = false
const beforeUnmount = stdout.output.length
instance.unmount()
assert.match(
  stdout.output.slice(beforeUnmount),
  /a=d,d=I,i=/u,
  'alt-screen exit must delete images',
)

for (const [key, value] of Object.entries(previousEnv)) {
  const envKey =
    key === 'tmux'
      ? 'TMUX'
      : key === 'sty'
        ? 'STY'
        : key === 'accessibility'
          ? 'CLAUDE_CODE_ACCESSIBILITY'
          : 'DSH_TUI_DISABLE_TERMINAL_IMAGES'
  if (value === undefined) delete process.env[envKey]
  else process.env[envKey] = value
}
chalk.level = previousChalkLevel

console.log('PASS: terminal images keep fallback, probe, chunk, place, and clean up')
