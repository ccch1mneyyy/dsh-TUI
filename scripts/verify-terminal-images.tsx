/** Kitty graphics protocol, fallback, placement, and lifecycle regression. */

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { AlternateScreen, Image, render, Text } from '../src/ui.js'
import { createNode } from '../src/ink/dom.js'
import {
  KittyGraphicsManager,
  transmitKittyRgba,
} from '../src/ink/kitty-graphics.js'
import Output from '../src/ink/output.js'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
} from '../src/ink/parse-keypress.js'
import { CharPool, createScreen, HyperlinkPool, StylePool } from '../src/ink/screen.js'
import { kittyGraphics } from '../src/ink/terminal-querier.js'
import {
  isTerminalImageSource,
  type TerminalImageSource,
} from '../src/ink/terminal-image.js'
import { settled } from './lib/term-test.mjs'

const source: TerminalImageSource = {
  data: new Uint8Array(40 * 40 * 4).fill(127),
  width: 40,
  height: 40,
}

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
assert.match(chunks[0]![1]!, /a=T,t=d,f=32,s=40,v=40,i=101/u)
assert.ok(chunks.slice(1).every(match => !match[1]!.includes('f=32')))

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
assert.match(first, /a=T,t=d,f=32/u)
assert.match(first, /a=p,i=101,p=1,c=6,r=3,C=1/u)
assert.equal(manager.reconcile([placement]), '', 'stable frame must emit no graphics bytes')
const moved = manager.reconcile([{ ...placement, x: 4 }])
assert.doesNotMatch(moved, /a=T/u)
assert.match(moved, /a=p,i=101/u)
manager.invalidateAll()
assert.match(manager.reconcile([placement]), /a=T,t=d,f=32/u)
assert.match(manager.reconcile([]), /a=d,d=I,i=101/u)

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
const tree = (
  <AlternateScreen>
    <Image source={source} width={4} height={2} alt="cover art">
      <Text>{'▓▓▓▓\n▓▓▓▓'}</Text>
    </Image>
  </AlternateScreen>
)
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
      stdout.output.includes('a=T,t=d,f=32') &&
      stdout.output.includes('a=p,i='),
  ),
  'a successful query must upload and place RGBA pixels',
)
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
  await settled(() => stdout.output.slice(beforeRestore).includes('a=T,t=d,f=32')),
  'restoring a source must upload it again',
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

console.log('PASS: terminal images keep fallback, probe, chunk, place, and clean up')
