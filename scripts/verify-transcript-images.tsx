/**
 * Durable transcript-image projection and message-list rendering regression.
 *
 * Run: node --import tsx/esm scripts/verify-transcript-images.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '0'

import assert from 'node:assert/strict'
import { closeSync, openSync } from 'node:fs'
import { devNull } from 'node:os'
import { isAbsolute } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import { loadSharp, sharpCandidatePaths } from '../src/dsh-adapter/sharp.js'
import type { TranscriptImage } from '../src/dsh-adapter/transcript-images.js'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { DOMElement } from '../src/ink/dom.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TimelineSnapshot } from '../src/ink/timeline-rail.js'
import { settled } from './lib/term-test.mjs'
import { kittyGraphics } from '../src/ink/terminal-querier.js'

const { Terminal: XTerm } = xterm
const [
  { render, AlternateScreen, Box, Text },
  { MessageList },
  { clearTranscriptImageCacheForTests, TranscriptImages },
  { transcriptImagesOf },
  { createChannel },
  { setLang },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/components/messages/TranscriptImages.js'),
  import('../src/dsh-adapter/transcript-images.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
])

const sharp = await loadSharp()
if (sharp === undefined) {
  console.log('SKIP transcript image regression: optional sharp decoder is unavailable')
  process.exit(0)
}

const png = new Uint8Array(await sharp({
  create: {
    width: 16,
    height: 8,
    channels: 4,
    background: { r: 35, g: 95, b: 210, alpha: 1 },
  },
}).png().toBuffer())

const attachment = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: png.byteLength,
  width: 16,
  height: 8,
  name: 'sample.png',
} as const
const nestedAttachment = {
  ...attachment,
  attachmentId: `sha256:${'b'.repeat(64)}`,
  name: 'nested.png',
} as const

let reader: { readImage(ref: unknown): Promise<{ data: Uint8Array }> } | undefined
const blocks = [
  { type: 'text', text: '' },
  { type: 'image', attachment },
] as unknown as readonly ContentBlock[]
const projected = transcriptImagesOf(blocks, () => reader)
assert.equal(projected.length, 1)
assert.deepEqual(
  {
    id: projected[0]!.id,
    width: projected[0]!.width,
    height: projected[0]!.height,
    name: projected[0]!.name,
  },
  {
    id: attachment.attachmentId,
    width: attachment.width,
    height: attachment.height,
    name: attachment.name,
  },
)
await assert.rejects(projected[0]!.read(), /unavailable/u)
let readCount = 0
reader = {
  async readImage(ref) {
    assert.equal(ref, attachment, 'reader receives the exact durable reference')
    readCount += 1
    return { data: png }
  },
}
assert.deepEqual(await projected[0]!.read(), png)
assert.equal(readCount, 1, 'the facade resolves a late-mounted attachment store')

const malformed = transcriptImagesOf([
  { type: 'image', attachment: { ...attachment, width: 0 } },
] as unknown as readonly ContentBlock[], () => reader)
assert.equal(malformed.length, 0, 'invalid durable dimensions are skipped')
assert.deepEqual(
  transcriptImagesOf([
    null,
    undefined,
    { type: 'tool-result' },
    { type: 'tool-result', content: null },
    { type: 'tool-result', content: {} },
    { type: 'tool-result', content: 'invalid' },
    { type: 'tool-result', content: [null, { type: 'image', attachment }] },
    { type: 'image', attachment: nestedAttachment },
  ] as unknown as readonly ContentBlock[], () => reader).map(image => image.id),
  [attachment.attachmentId, nestedAttachment.attachmentId],
  'malformed blocks and nested content do not hide valid sibling images',
)

const toolResult = {
  type: 'tool-result',
  toolCallId: 'call-1',
  content: [
    { type: 'image', attachment },
    {
      type: 'tool-result',
      toolCallId: 'nested-call',
      content: [{ type: 'image', attachment: nestedAttachment }],
    },
  ],
} as unknown as Extract<ContentBlock, { type: 'tool-result' }>
assert.deepEqual(
  transcriptImagesOf(toolResult.content, () => reader).map(image => image.id),
  [attachment.attachmentId, nestedAttachment.attachmentId],
  'nested tool-result image content uses the same ordered projection',
)

function channelFixture(events: object[] = []): {
  readonly channel: ReturnType<typeof createChannel>
  readonly emit: (event: object) => void
} {
  const handlers = new Map<string, (...args: never[]) => void>()
  const session = {
    id: 'transcript-images-session',
    seq: events.at(-1) === undefined ? 0 : (events.at(-1) as { seq: number }).seq,
    events: [...events],
  }
  const ctx = {
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
    get(name: string) {
      return name === 'attachments' ? reader : undefined
    },
    logger: { warn() {} },
  }
  const agent = {
    id: 'transcript-images-agent',
    status: 'idle',
    session,
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  const channel = createChannel(ctx as never, agent as never, {
    model: 'fixture-model',
    cwd: '/tmp',
    provider: 'fixture-provider',
    activity: false,
  })
  return {
    channel,
    emit(event) {
      session.events.push(event)
      session.seq = (event as { seq: number }).seq
      handlers.get('session/event')?.(session as never, event as never)
    },
  }
}

const durableEvents = [
  {
    type: 'user/message',
    seq: 1,
    time: 1,
    data: { source: { kind: 'user' }, content: blocks },
  },
  {
    type: 'assistant/message',
    seq: 2,
    time: 2,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'image', attachment }] },
    },
  },
  {
    type: 'tool/call',
    seq: 3,
    time: 3,
    data: { turn: 1, step: 1, callId: 'call-1', name: 'image_tool', arguments: '{}' },
  },
  {
    type: 'tool/result',
    seq: 4,
    time: 4,
    data: {
      turn: 1,
      step: 1,
      message: { source: { callId: 'call-1' }, content: [toolResult] },
    },
  },
] as const

const live = channelFixture()
for (const event of durableEvents) live.emit(event)
const transcriptShape = (rows: readonly ChatRow[]): unknown => rows
  .filter(row => row.kind === 'user' || row.kind === 'assistant' || row.kind === 'tool')
  .map(row => ({
    kind: row.kind,
    text: row.text,
    images: row.images?.map(image => image.id) ?? [],
  }))
assert.deepEqual(transcriptShape(live.channel.rows), [
  { kind: 'user', text: '', images: [attachment.attachmentId] },
  { kind: 'assistant', text: '', images: [attachment.attachmentId] },
  {
    kind: 'tool',
    text: '',
    images: [attachment.attachmentId, nestedAttachment.attachmentId],
  },
])
assert.equal(readCount, 1, 'channel projection stays lazy and does not read pixels')

const replay = channelFixture([...durableEvents])
assert.deepEqual(
  transcriptShape(replay.channel.rows),
  transcriptShape(live.channel.rows),
  'live and replay project the same user, assistant, and tool images',
)

const COLS = 72
const ROWS = 36
const cleanupFd = openSync(devNull, 'w')

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  fd = cleanupFd
  output = ''
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.output += String(chunk)
    this.terminal.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

async function withTerminal(
  tree: React.ReactElement,
  check: (
    screen: () => string,
    rerender: (tree: React.ReactElement) => void,
    rawOutput: () => string,
  ) => Promise<void>,
  graphics = false,
  terminalImages = true,
): Promise<void> {
  const graphicsEnv = ['TMUX', 'STY', 'CLAUDE_CODE_ACCESSIBILITY', 'DSH_TUI_DISABLE_TERMINAL_IMAGES']
  const previousEnv = graphicsEnv.map(name => process.env[name])
  if (graphics) for (const name of graphicsEnv) delete process.env[name]
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const stdin = new FakeStdin()
  const wrap = (next: React.ReactElement): React.ReactElement => graphics
    ? <AlternateScreen>{next}</AlternateScreen>
    : next
  const app = await render(wrap(tree), {
    stdin: stdin as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream,
    stderr: new FakeStderr() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    terminalImages,
  })
  const screen = (): string => Array.from(
    { length: ROWS },
    (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
  ).join('\n')
  try {
    if (graphics && terminalImages) {
      assert.ok(await settled(() => stdout.output.includes(kittyGraphics(31).request)),
        'image demand starts the capability probe before decoding')
      stdin.write('\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1b[4;720;720t' +
        '\x1b[?61;4c\x1b[?61;4c\x1b[?61;4c')
    }
    await check(screen, next => { app.rerender(wrap(next)) }, () => stdout.output)
  } finally {
    await app.unmount()
    terminal.dispose()
    if (graphics) graphicsEnv.forEach((name, index) => {
      if (previousEnv[index] === undefined) delete process.env[name]
      else process.env[name] = previousEnv[index]
    })
  }
}

function image(id: string, name: string, fail = false): TranscriptImage {
  return {
    ...projected[0]!,
    id,
    name,
    async read() {
      if (fail) throw new Error('fixture read failed')
      return png
    },
  }
}

clearTranscriptImageCacheForTests()
const rows: ChatRow[] = [
  { id: 1, kind: 'user', text: '', images: [image('user-image', 'user.png')] },
  { id: 2, kind: 'assistant', text: '', streaming: false, images: [image('assistant-image', 'assistant.png')] },
  {
    id: 3,
    kind: 'tool',
    text: '',
    images: [image('tool-image', 'tool.png')],
    tool: {
      callId: 'call-1',
      name: 'image_tool',
      argsText: '{}',
      status: 'ok',
      startedAt: 0,
    },
  },
]

let timeline: TimelineSnapshot | undefined
const messageList = (listRows: readonly ChatRow[] = rows): React.ReactElement => (
  <MessageList
    rows={listRows}
    expanded={false}
    expandedRows={new Set()}
    selectedId={null}
    onToggleRow={() => {}}
    model="fixture"
    showAll
    onToggleAll={() => {}}
    historyPaintEnabled={false}
    onTimeline={state => { timeline = state }}
  />
)

await withTerminal(
  messageList(),
  async screen => {
    assert.equal(
      await settled(() => {
        const text = screen()
        return text.includes('Image · user.png') && text.includes('Image · tool.png')
      }),
      true,
      'image-only user row and tool-result image stay visible',
    )
    assert.equal(await settled(() => timeline?.turns[0]?.preview === '1 image'), true)
    try {
      setLang('zh')
      assert.equal(
        await settled(() => timeline?.turns[0]?.preview === '1 张图片'),
        true,
        'image-only timeline previews update when language changes without new rows or geometry',
      )
    } finally {
      setLang('en')
    }
    assert.equal(await settled(() => timeline?.turns[0]?.preview === '1 image'), true)
    assert.match(screen(), /Image · assistant\.png/u)
    assert.match(screen(), /image_tool/iu, 'tool card remains visible above its image')
  },
)

clearTranscriptImageCacheForTests()
await withTerminal(
  <Box flexDirection="column">
    {messageList([{ id: 4, kind: 'assistant', text: '', streaming: false }])}
    <Text>empty-assistant-sentinel</Text>
  </Box>,
  async screen => {
    assert.equal(
      await settled(() => screen().includes('empty-assistant-sentinel')),
      true,
      'the empty-assistant fixture painted',
    )
    assert.doesNotMatch(screen(), /[●⏺]/u, 'a settled assistant without text or images stays filtered')
  },
)

clearTranscriptImageCacheForTests()
await withTerminal(
  messageList([{
    id: 5,
    kind: 'assistant',
    text: '',
    streaming: false,
    images: [image('assistant-only-image', 'only.png')],
  }]),
  async screen => {
    assert.equal(
      await settled(() => screen().includes('Image · only.png')),
      true,
      'an image-only assistant is not filtered',
    )
    assert.match(screen(), /[●⏺]/u, 'the isolated image-only assistant keeps its marker')
  },
)

clearTranscriptImageCacheForTests()
const virtualRows: ChatRow[] = Array.from({ length: 40 }, (_, index) => ({
  id: 100 + index,
  kind: index === 39 ? 'tool' : 'user',
  text: index === 39 ? '' : `virtual row ${index}`,
  ...(index === 39
    ? {
        tool: {
          callId: 'virtual-tool',
          name: 'image_tool',
          argsText: '{}',
          status: 'running' as const,
          startedAt: 0,
        },
      }
    : {}),
}))
const virtualTarget = virtualRows.at(-1)!
let virtualScrollTop = 0
const virtualScroll: ScrollBoxHandle = {
  scrollTo(y) { virtualScrollTop = y },
  scrollBy(dy) { virtualScrollTop += dy },
  scrollToElement() {},
  scrollToBottom() {},
  getScrollTop: () => virtualScrollTop,
  getPendingDelta: () => 0,
  getScrollHeight: () => 100,
  getFreshScrollHeight: () => 100,
  getViewportHeight: () => 8,
  getViewportTop: () => 0,
  isSticky: () => false,
  subscribe: () => () => {},
  setClampBounds() {},
}
let targetMounts = 0
let targetUnmounts = 0
let targetElement: DOMElement | null = null
const virtualList = (forceTarget = false): React.ReactElement => (
  <MessageList
    rows={virtualRows}
    expanded={false}
    expandedRows={new Set()}
    selectedId={null}
    onToggleRow={() => {}}
    model="fixture"
    showAll
    onToggleAll={() => {}}
    historyPaintEnabled={false}
    scrollHandle={virtualScroll}
    forceMountRowId={forceTarget ? virtualTarget.id : null}
    registerRowRef={(rowId, element) => {
      if (rowId !== virtualTarget.id) return
      targetElement = element
      if (element === null) targetUnmounts += 1
      else targetMounts += 1
    }}
  />
)
await withTerminal(
  virtualList(true),
  async (_screen, rerender) => {
    assert.equal(
      await settled(() => (targetElement?.yogaNode?.getComputedHeight() ?? 0) > 0),
      true,
      'the target tool row was measured',
    )
    rerender(virtualList())
    assert.equal(await settled(() => targetUnmounts > 0), true, 'the measured target moved offscreen')
    const mountsBeforeImage = targetMounts
    virtualTarget.images = [image('late-tool-image', 'late.png')]
    rerender(virtualList())
    assert.equal(
      await settled(() => targetMounts > mountsBeforeImage),
      true,
      `adding a durable tool image invalidates and remeasures an offscreen cached row (mounts=${targetMounts}, unmounts=${targetUnmounts}, before=${mountsBeforeImage})`,
    )
  },
)

for (const [graphics, terminalImages] of [[false, true], [true, false]] as const) {
  clearTranscriptImageCacheForTests()
  let fallbackReads = 0
  await withTerminal(
    <TranscriptImages images={[{
      ...image('no-graphics', 'metadata.png'),
      async read() { fallbackReads += 1; return png },
    }]} indent={0} />,
    async (screen, _rerender, rawOutput) => {
      assert.equal(await settled(() => screen().includes('Image · metadata.png')), true)
      assert.equal(fallbackReads, 0, 'inline or disabled previews never read attachment pixels')
      assert.doesNotMatch(rawOutput(), /\x1b_G/u, 'metadata fallback does not probe or render images')
    },
    graphics,
    terminalImages,
  )
}

clearTranscriptImageCacheForTests()
let firstStoreReads = 0
let secondStoreReads = 0
const sharedIdA: TranscriptImage = {
  ...image('shared-id', 'store-a.png'),
  async read() { firstStoreReads += 1; return png },
}
const alternatePng = new Uint8Array(await sharp({
  create: {
    width: 8,
    height: 16,
    channels: 4,
    background: { r: 210, g: 60, b: 50, alpha: 1 },
  },
}).png().toBuffer())
const sharedIdB: TranscriptImage = {
  ...image('shared-id', 'store-b.png'),
  async read() { secondStoreReads += 1; return alternatePng },
}
await withTerminal(
  <TranscriptImages images={[sharedIdA, sharedIdB]} indent={0} />,
  async _screen => {
    assert.equal(
      await settled(() => firstStoreReads === 1 && secondStoreReads === 1),
      true,
      'different stores may reuse an opaque attachment id without sharing pixels',
    )
    assert.deepEqual([firstStoreReads, secondStoreReads], [1, 1])
  },
  true,
)

clearTranscriptImageCacheForTests()
await withTerminal(
  <Box flexDirection="column" width={COLS}>
    <TranscriptImages images={[image('wide-image', 'wide.png')]} indent={0} />
    <Text>image-sentinel</Text>
  </Box>,
  async screen => {
    assert.equal(
      await settled(() => screen().includes('Image · wide.png')),
      true,
      'an image has a readable metadata fallback without decoding',
    )
    const lines = screen().split('\n')
    assert.equal(
      lines.findIndex(line => line.includes('image-sentinel')),
      6,
      'a 2:1 image reserves a 24×6 terminal-cell preview box',
    )
  },
)

clearTranscriptImageCacheForTests()
await withTerminal(
  <TranscriptImages images={[image('failed-image', '\u001b[31mbad.png\u001b[0m', true)]} indent={0} />,
  async (screen, _rerender, rawOutput) => {
    assert.equal(
      await settled(() => screen().includes('Cannot preview bad.png')),
      true,
      'failed attachment reads use a text alternative with a sanitized image name',
    )
    assert.ok(!rawOutput().includes('\u001b[31mbad.png\u001b[0m'), 'injected label ANSI never reaches the terminal')
  },
  true,
)

await withTerminal(
  <TranscriptImages images={[image('unnamed-failed-image', '', true)]} indent={0} />,
  async screen => {
    assert.equal(await settled(() => screen().includes('Cannot preview Image')), true)
    try {
      setLang('zh')
      assert.equal(
        await settled(() => screen().includes('无法预览 图片')),
        true,
        'a mounted gallery refreshes its status and unnamed-image label on language changes',
      )
    } finally {
      setLang('en')
    }
  },
  true,
)

// --- host-first sharp loader ------------------------------------------------
// One sharp instance per process: the loader is memoized, the module it
// returns is callable, and every candidate path is an absolute entry file
// (host tree first when the anchor resolves, own optional copy last).
{
  const candidates = sharpCandidatePaths()
  assert.ok(candidates.length >= 1, 'at least one sharp candidate path resolves')
  assert.ok(candidates.every(path => isAbsolute(path) && path.includes('sharp')), candidates.join('\n'))
  const first = await loadSharp()
  const second = await loadSharp()
  assert.equal(typeof first, 'function', 'loadSharp returns the callable sharp module')
  assert.equal(first, second, 'loadSharp memoizes one module instance')
}

closeSync(cleanupFd)
console.log('Transcript image projection and rendering regression passed')
