/**
 * Interactive image preview regression: staged-token and transcript
 * thumbnails share one modal overlay (open by click, close by Esc and
 * click-outside), Finder-file/drop paste paths stage conservatively.
 *
 * Run: node --import tsx/esm scripts/verify-image-preview.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '0'
// The channel-level cases below drive a REAL `/new` session switch, which
// persists resume/last-used markers — keep them out of the user's ~/.dsh-tui.
process.env.HOME = new URL('../node_modules/.cache/dsh-tui-image-preview-home', import.meta.url).pathname
// Force the deterministic text fallback everywhere: Kitty transport has its
// own regression (verify-terminal-images); THIS script pins interaction.
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
mkdirSync(process.env.HOME!, { recursive: true })
import React from 'react'
import xterm from '@xterm/headless'
import sharp from 'sharp'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { PromptController } from '../src/components/PromptInput.js'
import type { TuiStatusViewProps } from '../src/dsh-adapter/status.js'
import type { TranscriptImage } from '../src/dsh-adapter/transcript-images.js'
import { settled, sleep } from './lib/term-test.mjs'

const { Terminal: XTerm } = xterm
const [
  { render, AlternateScreen, Box },
  { Chat },
  { QuestionStore },
  { ImagePreviewOverlay },
  { clearTranscriptImageCacheForTests, TranscriptImages },
  { parsePastedImagePath, stageClipboardFilePaths },
  { PromptInput },
  { TuiStatusStore },
  { LOCAL_COMMANDS },
  { createChannel },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/components/ImagePreviewOverlay.js'),
  import('../src/components/messages/TranscriptImages.js'),
  import('../src/utils/pastedImagePath.js'),
  import('../src/components/PromptInput.js'),
  import('../src/dsh-adapter/status.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/channel.js'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

{
  const chatSource = readFileSync(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8')
  const previewModalGuard = chatSource.indexOf("if (overlay.kind === 'image-preview') {")
  const mouseSelectionEsc = chatSource.indexOf('if (key.escape && hasMouseSelection())')
  check('chat: preview modal consumes Esc before transcript mouse selection',
    previewModalGuard !== -1 && mouseSelectionEsc > previewModalGuard,
    `preview=${previewModalGuard}, selection=${mouseSelectionEsc}`)
  check('chat: modal owns the global graphics budget while open',
    chatSource.includes("overlay.kind !== 'image-preview' && statusViews.map(view => (")
      && chatSource.includes("suppressImageGraphics={overlay.kind === 'image-preview'}"))
  check('chat: adapter command outcomes own draft-consumption semantics',
    chatSource.includes('outcome.consumeDraft'))
}

// --- parsePastedImagePath: conservative drop-path recognition --------------
{
  const home = (await import('node:os')).homedir()
  const cases: Array<[string, string | null]> = [
    ['/tmp/a.png', '/tmp/a.png'],
    ['/tmp/a.PNG \n', '/tmp/a.PNG'],
    ['/tmp/with\\ space.jpeg', '/tmp/with space.jpeg'],
    ["'/tmp/a b.webp'", '/tmp/a b.webp'],
    ['"/tmp/a b.gif"', '/tmp/a b.gif'],
    ['"/tmp/a\\\\b.png"', '/tmp/a\\b.png'],
    ['"/tmp/a\\ b.png"', null],
    ['"/tmp/a\\q.png"', null],
    ['~/pic.png', `${home}/pic.png`],
    ['/tmp/a.png /tmp/b.png', null],
    ['see /tmp/a.png', null],
    ['/tmp/notes.txt', null],
    ['relative.png', null],
    ['"/tmp/unterminated.png', null],
    ['/tmp/dangling.png\\', null],
    ['/tmp/multi\nline.png', null],
  ]
  check('parse: conservative single-image-path recognition',
    cases.every(([input, want]) => parsePastedImagePath(input) === want),
    JSON.stringify(cases.map(([input]) => [input, parsePastedImagePath(input)])))
}

// --- stageClipboardFilePaths: image files stage, others stay paths ---------
{
  let sequence = 0
  const outcome = await stageClipboardFilePaths(
    ['/tmp/a.png', '/tmp/notes.txt', '/tmp/broken.png', '/tmp/b.jpg'],
    async path => {
      if (path.includes('broken')) throw new Error('stage refused')
      sequence += 1
      return `[Image #${sequence}]`
    },
    path => `@${path}`,
  )
  check('files: images become tokens in offer order, others keep the path insert',
    JSON.stringify(outcome.parts.map(part => part.value))
      === JSON.stringify(['[Image #1]', '@/tmp/notes.txt', '@/tmp/broken.png', '[Image #2]']),
    JSON.stringify(outcome))
  check('files: staged tokens and the last failure are reported',
    JSON.stringify(outcome.staged) === JSON.stringify(['[Image #1]', '[Image #2]']) && outcome.failure === 'stage refused')

  sequence = 0
  const capped = await stageClipboardFilePaths(
    ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
    async () => `[Image #${++sequence}]`,
    path => `@${path}`,
    2,
  )
  check('files: Finder batches never stage past the remaining draft limit',
    sequence === 2
      && JSON.stringify(capped.parts.map(part => part.value))
        === JSON.stringify(['[Image #1]', '[Image #2]', '@/tmp/c.png'])
      && capped.failure?.includes('limit') === true,
    JSON.stringify(capped))
}


const png = new Uint8Array(await sharp({
  create: { width: 16, height: 8, channels: 4, background: { r: 40, g: 90, b: 200, alpha: 1 } },
}).png().toBuffer())

// --- channel: staging numbering, limits, session-switch fence, stale token --
{
  type Deferred = { resolve: (value: unknown) => void; reject: (error: Error) => void }
  const pendingSaves: Deferred[] = []
  let commandDefinition = {
    name: 'probe',
    description: 'Probe image admission',
    input: { hint: '', images: true },
  }
  let commandExecutions = 0
  let commandImages: readonly { data: string; name?: string }[] = []
  const deliveredMessages: unknown[] = []
  let imageReads = 0
  let unreadableName: string | undefined
  let readBarrier: Promise<void> | undefined
  let grantsAllow = true
  const savedRef = (index: number) => ({
    attachmentId: `sha256:${String(index).repeat(64).slice(0, 64)}`,
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
    name: `save-${index}.png`,
  })
  const attachments = {
    imageLimits: {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4 * 1024 * 1024,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    saveImage: () =>
      new Promise((resolve, reject) => { pendingSaves.push({ resolve, reject }) }),
    readImage: async (ref: { bytes: number; name?: string }) => {
      imageReads += 1
      if (readBarrier !== undefined) await readBarrier
      if (ref.name === unreadableName) throw new Error('fixture unreadable')
      return { data: new Uint8Array(ref.bytes).fill(7) }
    },
  }
  const commandService = {
    list: () => [commandDefinition],
    find: (_agent: unknown, name: string) => name === 'probe' ? commandDefinition : undefined,
    async execute(
      _agent: unknown,
      _line: string,
      images: readonly { data: string; name?: string }[],
      _signal: AbortSignal,
    ) {
      commandExecutions += 1
      commandImages = images
      return { commandId: 'fixture', result: { kind: 'success', text: 'accepted' } }
    },
  }
  const makeAgent = (id: string) => ({
    id,
    status: 'idle',
    session: { id, seq: 0, events: [] },
    ctx: { on: () => () => {} },
    followup(message: unknown) { deliveredMessages.push(message) },
    steer() {},
    cancel() {},
  })
  const ctx = {
    on: () => () => {},
    get: (name: string) =>
      name === 'attachments'
        ? attachments
        : name === 'commands'
          ? commandService
          : name === 'tuiPluginHost'
            ? { grants: { allows: () => grantsAllow } }
        : name === 'agents'
          ? { create: async () => ({ agent: makeAgent('fresh-session'), dispose: async () => {} }) }
          : undefined,
    logger: { warn() {}, info() {}, error() {} },
  }
  const channel = createChannel(ctx as never, makeAgent('old-session') as never, {
    model: 'fixture-model',
    cwd: '/tmp',
    provider: 'fixture-provider',
    activity: false,
  })
  const stageOne = (name: string) =>
    channel.stageComposerImage(
      { data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png', name },
      channel.stagedImageGeneration(),
    )

  check('channel: stagedImageLimits exposes the profile byte limit',
    channel.stagedImageLimits()?.maxImageBytes === 1024 * 1024)

  // Durable staging returns opaque, non-reusable capabilities; presentation
  // numbering belongs to PromptInput and a rejected save returns no handle.
  const first = stageOne('a.png')
  await settled(() => pendingSaves.length === 1)
  pendingSaves[0]!.resolve(savedRef(1))
  const firstHandle = await first
  const second = stageOne('broken.png')
  await settled(() => pendingSaves.length === 2)
  pendingSaves[1]!.reject(new Error('admission refused'))
  await assert.rejects(second, /admission refused/u)
  const third = stageOne('c.png')
  await settled(() => pendingSaves.length === 3)
  pendingSaves[2]!.resolve(savedRef(3))
  const thirdHandle = await third
  check('channel: successful saves receive distinct live capabilities',
    firstHandle.stageId !== thirdHandle.stageId &&
    channel.stagedImage(firstHandle.stageId) !== undefined &&
    channel.stagedImage(thirdHandle.stageId) !== undefined)

  // The session-switch fence: a save resolving AFTER /new must not register
  // its token (or bump the fresh session's sequence).
  const inFlight = stageOne('stale.png')
  inFlight.catch(() => {})
  await settled(() => pendingSaves.length === 4)
  assert.equal(await channel.newSession(), true, 'fixture /new must switch')
  pendingSaves[3]!.resolve(savedRef(4))
  await assert.rejects(inFlight, /session changed/u)
  check('channel: a save landing after /new registers nothing',
    channel.stagedImage(firstHandle.stageId) === undefined &&
    channel.stagedImage(thirdHandle.stageId) === undefined)
  const fresh = stageOne('fresh.png')
  await settled(() => pendingSaves.length === 5)
  pendingSaves[4]!.resolve(savedRef(5))
  const freshHandle = await fresh
  check('channel: the fresh session capability is live and never reuses an old id',
    freshHandle.stageId !== firstHandle.stageId &&
    channel.stagedImage(freshHandle.stageId) !== undefined)

  const freshSecond = stageOne('fresh-b.png')
  await settled(() => pendingSaves.length === 6)
  pendingSaves[5]!.resolve(savedRef(6))
  const freshSecondHandle = await freshSecond
  const commandRefs = [
    { token: '[Image #1]', stageId: freshHandle.stageId },
    { token: '[Image #2]', stageId: freshSecondHandle.stageId },
  ]
  const runProbe = () => channel.runExternalCommandOutcome(
    'probe',
    ' [Image #1] [Image #2]',
    commandRefs,
  )

  // Metadata admission is atomic and precedes reads/base64. A batch that is
  // too large must neither touch storage nor partially invoke the handler.
  attachments.imageLimits.maxImagesPerMessage = 1
  const beforeLimitReads = imageReads
  const limited = await runProbe()
  check('channel: command image count limits reject before storage reads',
    limited?.kind === 'error' && limited.consumeDraft === false
      && imageReads === beforeLimitReads && commandExecutions === 0,
    JSON.stringify({ limited, imageReads, commandExecutions }))

  attachments.imageLimits.maxImagesPerMessage = 4
  attachments.imageLimits.maxMessageImageBytes = 7
  const beforeBytesReads = imageReads
  const bytesLimited = await runProbe()
  check('channel: command aggregate byte limits reject before storage reads',
    bytesLimited?.kind === 'error' && bytesLimited.consumeDraft === false
      && imageReads === beforeBytesReads && commandExecutions === 0,
    JSON.stringify({ bytesLimited, imageReads, commandExecutions }))

  attachments.imageLimits.maxMessageImageBytes = 16
  unreadableName = 'save-6.png'
  const unreadable = await runProbe()
  check('channel: one unreadable command image aborts the whole invocation',
    unreadable?.kind === 'error' && unreadable.consumeDraft === false
      && commandExecutions === 0,
    JSON.stringify({ unreadable, imageReads, commandExecutions }))

  unreadableName = undefined
  const accepted = await runProbe()
  check('channel: a complete command image batch executes once in text order',
    accepted?.kind === 'success' && accepted.consumeDraft === true
      && commandExecutions === 1
      && commandImages.length === 2
      && commandImages[0]?.name === 'save-5.png'
      && commandImages[1]?.name === 'save-6.png',
    JSON.stringify({ accepted, commandExecutions, commandImages }))

  const legacyText = await channel.runExternalCommand('probe', '')
  check('channel: public scene command API retains its legacy text result',
    legacyText === 'accepted', JSON.stringify(legacyText))

  // Definition identity is rechecked after asynchronous attachment reads:
  // unloading/replacing a same-name registration may not inherit an already
  // prepared and authorized batch.
  let releaseRead = (): void => {}
  readBarrier = new Promise<void>(resolve => { releaseRead = resolve })
  const beforeSwapReads = imageReads
  const beforeSwapExecutions = commandExecutions
  const swapped = runProbe()
  await settled(() => imageReads > beforeSwapReads)
  commandDefinition = { ...commandDefinition }
  releaseRead()
  const swappedOutcome = await swapped
  readBarrier = undefined
  check('channel: a command definition swap during image reads stale-drops',
    swappedOutcome?.kind === 'error' && swappedOutcome.consumeDraft === false
      && commandExecutions === beforeSwapExecutions,
    JSON.stringify({ swappedOutcome, commandExecutions }))

  let releaseGrantRead = (): void => {}
  readBarrier = new Promise<void>(resolve => { releaseGrantRead = resolve })
  const beforeGrantReads = imageReads
  const beforeGrantExecutions = commandExecutions
  const revoked = runProbe()
  await settled(() => imageReads > beforeGrantReads)
  grantsAllow = false
  releaseGrantRead()
  const revokedOutcome = await revoked
  readBarrier = undefined
  grantsAllow = true
  check('channel: a grant revoked during image reads blocks execution',
    revokedOutcome?.kind === 'error' && revokedOutcome.consumeDraft === false
      && commandExecutions === beforeGrantExecutions,
    JSON.stringify({ revokedOutcome, commandExecutions }))

  const legacyStaging = channel.stageImage({
    data: new Uint8Array([1, 2, 3, 4]),
    mediaType: 'image/png',
    name: 'legacy-scene.png',
  })
  await settled(() => pendingSaves.length === 7)
  pendingSaves[6]!.resolve(savedRef(7))
  const legacyToken = await legacyStaging
  const beforeLegacyDelivery = deliveredMessages.length
  channel.submit(`legacy scene ${legacyToken}`)
  await settled(() => deliveredMessages.length === beforeLegacyDelivery + 1)
  const legacyMessage = deliveredMessages.at(-1) as
    | { content?: readonly { type?: string; text?: string }[] }
    | undefined
  check('channel: public stageImage token still submits a real image block',
    legacyToken === '[Image #1]'
      && legacyMessage?.content?.some(block => block.type === 'image') === true
      && legacyMessage.content.some(block => block.type === 'text' && block.text?.includes(legacyToken) === true),
    JSON.stringify({ legacyToken, legacyMessage }))

  // A stale placeholder in submitted text warns loudly (and still sends).
  channel.submit('please look at [Image #7]')
  check('channel: submitting an unstaged token raises a visible warning',
    await settled(() => channel.notifications.some(item =>
      item.text.includes('[Image #7]') && item.text.includes('no longer staged'))),
    JSON.stringify(channel.notifications))

  const notificationCount = channel.notifications.length
  channel.submit('!echo ignored', [{ token: '[Image #1]', stageId: freshHandle.stageId }])
  check('channel: non-UI shell callers reject image capabilities loudly',
    channel.notifications.length === notificationCount + 1
      && channel.notifications.at(-1)?.text.includes('Shell commands') === true,
    JSON.stringify(channel.notifications.at(-1)))
}

// --- shared fixtures --------------------------------------------------------

const readCounts = new Map<string, number>()
function fakeImage(id: string, name: string, fail = false): TranscriptImage {
  return {
    id,
    width: 16,
    height: 8,
    name,
    mediaType: 'image/png',
    async read() {
      readCounts.set(id, (readCounts.get(id) ?? 0) + 1)
      if (fail) throw new Error('fixture read failed')
      return png
    },
  }
}

const COLS = 80
const ROWS = 30
// CSI-u: Ctrl+Shift+E (E=69, modifier 6 = ctrl+shift).
const CTRL_SHIFT_E = '\x1b[69;6u'
const CTRL_G = '\x07'

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

type Screen = {
  readonly text: () => string
  readonly find: (needle: string) => { row: number; col: number } | null
}
function screenOf(terminal: InstanceType<typeof XTerm>, rows: number): Screen {
  const lines = (): string[] => Array.from(
    { length: rows },
    (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
  )
  return {
    text: () => lines().join('\n'),
    find: needle => {
      const all = lines()
      for (let row = 0; row < all.length; row++) {
        const col = all[row]!.indexOf(needle)
        if (col !== -1) return { row, col }
      }
      return null
    },
  }
}

// --- overlay component: metadata, narrow fallback, failed read -------------
{
  clearTranscriptImageCacheForTests()
  const terminal = new XTerm({ cols: 30, rows: 10, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  stdout.columns = 30
  stdout.rows = 10
  const app = await render(
    // The overlay is an absolute layer; give it the sized ancestor Chat's
    // root Box provides in production.
    <Box width={30} height={10}>
      <ImagePreviewOverlay image={fakeImage('sha256:narrow', 'narrow.png')} onClose={() => {}} />
    </Box>,
    { stdin: new FakeStdin() as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const screen = screenOf(terminal, 10)
  check('overlay: narrow terminal renders the metadata card',
    await settled(() =>
      screen.text().includes('narrow.png') &&
      screen.text().includes('16×8px') &&
      screen.text().includes('Esc or click outside')),
    screen.text())
  check('overlay: narrow terminal reserves no graphics box',
    !screen.text().includes('[Loading'))
  check('overlay: the metadata-only card never reads pixels',
    (readCounts.get('sha256:narrow') ?? 0) === 0)
  await app.unmount()
  terminal.dispose()
}
{
  clearTranscriptImageCacheForTests()
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const app = await render(
    <Box width={COLS} height={ROWS}>
      <ImagePreviewOverlay image={fakeImage('sha256:ready', 'ready.png')} onClose={() => {}} />
    </Box>,
    { stdin: new FakeStdin() as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const screen = screenOf(terminal, ROWS)
  check('overlay: graphics-disabled wide fallback reaches the ready state',
    await settled(() =>
      screen.text().includes('[Image · ready.png]') &&
      !screen.text().includes('[Loading ready.png]')),
    screen.text())
  await app.unmount()
  terminal.dispose()
}
{
  clearTranscriptImageCacheForTests()
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const app = await render(
    <Box width={COLS} height={ROWS}>
      <ImagePreviewOverlay image={fakeImage('sha256:bad', 'bad.png', true)} onClose={() => {}} />
    </Box>,
    { stdin: new FakeStdin() as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const screen = screenOf(terminal, ROWS)
  check('overlay: failed read degrades to the unavailable text state',
    await settled(() => screen.text().includes('Cannot preview bad.png')),
    screen.text())
  check('overlay: header metadata still renders on failure',
    screen.text().includes('image/png · 16×8px'))
  await app.unmount()
  terminal.dispose()
}
{
  clearTranscriptImageCacheForTests()
  const id = 'sha256:\x1b[31mBAD\x07'
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const app = await render(
    <Box width={COLS} height={ROWS}>
      <ImagePreviewOverlay image={fakeImage(id, 'safe.png')} onClose={() => {}} />
    </Box>,
    { stdin: new FakeStdin() as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const screen = screenOf(terminal, ROWS)
  check('overlay: untrusted attachment ids render control-free text',
    await settled(() => screen.text().includes('source sha256:BAD')),
    screen.text())
  await app.unmount()
  terminal.dispose()
}

// Background galleries must stop decoding/placing graphics while the modal
// owns the renderer's global byte + placement budget, then recover normally.
{
  clearTranscriptImageCacheForTests()
  const image = fakeImage('sha256:suppressed', 'suppressed.png')
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const stdin = new FakeStdin()
  const app = await render(
    <TranscriptImages images={[image]} suppressGraphics />,
    { stdin: stdin as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(100)
  check('transcript: modal suppression performs no thumbnail read',
    (readCounts.get(image.id) ?? 0) === 0,
    `reads=${readCounts.get(image.id) ?? 0}`)
  app.rerender(<TranscriptImages images={[image]} />)
  check('transcript: thumbnails resume after modal suppression ends',
    await settled(() => (readCounts.get(image.id) ?? 0) === 1),
    `reads=${readCounts.get(image.id) ?? 0}`)
  await app.unmount()
  terminal.dispose()
}

// --- Chat integration: one shared overlay for composer + transcript --------
function makeChannel() {
  const staged = new Map<string, TranscriptImage>([
    ['stage-1', fakeImage('sha256:staged', 'staged.png')],
  ])
  return {
    version: 0,
    rows: [
      { id: 1, kind: 'user', text: '', images: [fakeImage('sha256:sent', 'sent.png')] },
    ] as ChatRow[],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    agentBindingGeneration: 0,
    model: 'model-00',
    provider: 'fake-provider',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting' as const,
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    turnStart: 0,
    lastUserText: '',
    pending: [],
    commandList: LOCAL_COMMANDS,
    commandCompletions: () => [],
    notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submit() {},
    steer() {},
    cancel() {},
    clear() {},
    notify() {},
    stagedImageGeneration: () => 0,
    stageImage: async () => '[Image #1]',
    stageComposerImage: async () => ({ stageId: 'stage-1' }),
    discardStagedImage() {},
    hasStagedImage: (stageId: string) => staged.has(stageId),
    stagedImage: (stageId: string) => staged.get(stageId),
    stagedImageLimits: () => ({ maxImageBytes: 1024 * 1024, maxImagesPerMessage: 4 }),
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  }
}

{
  clearTranscriptImageCacheForTests()
  const pastedImagePath = `${process.env.HOME}/composer.png`
  writeFileSync(pastedImagePath, png)
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const stdin = new FakeStdin()
  const channel = makeChannel()
  const statusStore = new TuiStatusStore()
  statusStore.addView({
    key: 'budget-probe',
    maxRows: 1,
    registrationId: 1,
    component: ({ React: HostReact, ui }: TuiStatusViewProps) =>
      HostReact.createElement(ui.Text, null, 'RICH-BUDGET-PROBE'),
  }, 1, {})
  const chatTree = () => (
    <AlternateScreen>
      <Chat
        channel={channel as never}
        questionStore={new QuestionStore()}
        extensionStatus={statusStore}
        onExit={() => {}}
        fullscreen
      />
    </AlternateScreen>
  )
  // Pointer interaction is fullscreen-only (inline mode has no mouse
  // tracking); mirror the host's fullscreen wrapping.
  const app = await render(
    chatTree(),
    { stdin: stdin as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const screen = screenOf(terminal, ROWS)
  // 首帧挂载 pacing：同 verify-extension-ui,等 React 树与输入监听落地。
  await sleep(600)
  check('chat: rich status graphics surface is mounted without a preview',
    screen.text().includes('RICH-BUDGET-PROBE'), screen.text())

  const click = (col: number, row: number): void => {
    stdin.write(`\x1b[<0;${col + 1};${row + 1}M`)
    stdin.write(`\x1b[<0;${col + 1};${row + 1}m`)
  }
  const OVERLAY_HINT = 'Esc or click outside to close'

  // Transcript thumbnail (text fallback body) → the shared overlay.
  check('chat: transcript thumbnail fallback renders',
    await settled(() => screen.find('Image · sent.png') !== null), screen.text())
  const thumb = screen.find('Image · sent.png')!
  click(thumb.col, thumb.row)
  check('chat: thumbnail click opens the preview overlay',
    await settled(() =>
      screen.text().includes(OVERLAY_HINT) && screen.text().includes('sent.png')),
    screen.text())
  check('chat: preview temporarily unmounts rich status graphics consumers',
    !screen.text().includes('RICH-BUDGET-PROBE'), screen.text())

  // Keep the same public id but replace the agent binding (the ABA case from
  // /new -> resume). The old preview disappears in the replacement render,
  // before an effect can leak one stale frame.
  channel.agentBindingGeneration += 1
  channel.version += 1
  app.rerender(chatTree())
  check('chat: agent replacement closes a preview even when the id is reused',
    await settled(() => !screen.text().includes(OVERLAY_HINT)
      && screen.text().includes('RICH-BUDGET-PROBE')),
    screen.text())

  const thumbAfterBinding = screen.find('Image · sent.png')!
  click(thumbAfterBinding.col, thumbAfterBinding.row)
  await settled(() => screen.text().includes(OVERLAY_HINT))
  stdin.write('\x1b')
  check('chat: Esc closes the preview',
    await settled(() => !screen.text().includes(OVERLAY_HINT)
      && screen.text().includes('RICH-BUDGET-PROBE')), screen.text())

  // Reopen, then a click OUTSIDE the centered card closes it.
  const readsAfterFirstOpen = readCounts.get('sha256:sent') ?? 0
  const thumb2 = screen.find('Image · sent.png')!
  click(thumb2.col, thumb2.row)
  await settled(() => screen.text().includes(OVERLAY_HINT))
  click(0, 0)
  check('chat: click outside the card closes the preview',
    await settled(() => !screen.text().includes(OVERLAY_HINT)), screen.text())
  check('chat: reopening decodes from the LRU — no extra attachment read',
    readsAfterFirstOpen > 0 && (readCounts.get('sha256:sent') ?? 0) === readsAfterFirstOpen,
    `reads=${readCounts.get('sha256:sent')}`)

  // A raw history/rewind-looking token has no capability. Leave it in the
  // draft, then paste a real image: the allocator must skip #1 and bind #2.
  stdin.write('[Image #1]')
  check('chat: raw token text is visible but inert',
    await settled(() => screen.find('[Image #1]') !== null), screen.text())
  const rawToken = screen.find('[Image #1]')!
  click(rawToken.col + 2, rawToken.row)
  await sleep(150)
  check('chat: a raw token without sidecar capability does not open preview',
    !screen.text().includes(OVERLAY_HINT), screen.text())

  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  check('chat: fresh paste skips the occupied raw number and mints #2',
    await settled(() => screen.find('[Image #2]') !== null), screen.text())
  const token = screen.find('[Image #2]')!
  click(token.col + 2, token.row)
  check('chat: composer token click opens the preview with the staged image',
    await settled(() =>
      screen.text().includes(OVERLAY_HINT) && screen.text().includes('staged.png')),
    screen.text())
  stdin.write('\x1b')
  await settled(() => !screen.text().includes(OVERLAY_HINT))

  // The expanded editor stays mounted below the shared preview. The preview
  // must be visible, then one Esc closes ONLY it and reveals the same draft.
  stdin.write(CTRL_SHIFT_E)
  check('chat: staged token remains visible in the expanded editor',
    await settled(() =>
      screen.text().includes('Draft editor') &&
      screen.find('[Image #2]') !== null),
    screen.text())
  const editorToken = screen.find('[Image #2]')!
  click(editorToken.col + 2, editorToken.row)
  check('chat: preview is the top modal above the expanded editor',
    await settled(() =>
      screen.text().includes(OVERLAY_HINT) &&
      screen.text().includes('[Image · staged.png]') &&
      !screen.text().includes('Draft editor')),
    screen.text())
  stdin.write('\x1b')
  check('chat: Esc closes only the preview and restores the expanded draft',
    await settled(() =>
      !screen.text().includes(OVERLAY_HINT) &&
      screen.text().includes('Draft editor') &&
      screen.find('[Image #2]') !== null),
    screen.text())
  // Collapse the editor so the final outside-click negative case exercises
  // the ordinary Chat surface rather than the editor's full-screen catcher.
  stdin.write('\x1b')
  await settled(() => !screen.text().includes('Draft editor'))

  // An external-editor round trip is a new async draft lifecycle, but an
  // image token the editor preserves must keep its opaque sidecar binding.
  const savedVisual = process.env.VISUAL
  const savedEditor = process.env.EDITOR
  delete process.env.VISUAL
  process.env.EDITOR = `"${process.execPath}" -e "require('node:fs').appendFileSync(process.argv[1],' edited')"`
  stdin.write(CTRL_G)
  check('chat: external editor returns the preserved image token',
    await settled(() =>
      screen.text().includes('edited') &&
      screen.find('[Image #2]') !== null,
    { timeoutMs: 5000 }),
    screen.text())
  if (savedVisual === undefined) delete process.env.VISUAL
  else process.env.VISUAL = savedVisual
  if (savedEditor === undefined) delete process.env.EDITOR
  else process.env.EDITOR = savedEditor
  const editedToken = screen.find('[Image #2]')!
  click(editedToken.col + 2, editedToken.row)
  check('chat: external editor preserves the token capability binding',
    await settled(() =>
      screen.text().includes(OVERLAY_HINT) &&
      screen.text().includes('[Image · staged.png]')),
    screen.text())
  stdin.write('\x1b')
  await settled(() => !screen.text().includes(OVERLAY_HINT))

  // A plain text click (no token, no thumbnail) must not open anything.
  click(COLS - 3, 0)
  await sleep(200)
  check('chat: clicks elsewhere never open the preview',
    !screen.text().includes(OVERLAY_HINT))

  await app.unmount()
  terminal.dispose()
}

// --- Prompt command transaction: async settle never clears newer edits ----
{
  type CommandAttempt = { resolve: (consume: boolean) => void }
  const attempts: CommandAttempt[] = []
  let invocations = 0
  let generation = 0
  const channel = {
    ...makeChannel(),
    commandList: [
      ...LOCAL_COMMANDS,
      { name: 'vision', description: 'Fixture vision command', external: true, acceptsImages: true },
    ],
    stagedImageGeneration: () => generation,
  }
  const controllerRef = React.createRef<PromptController | null>()
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const stdin = new FakeStdin()
  const promptTree = () => (
    <PromptInput
      channel={channel as never}
      helpOpen={false}
      onToggleHelp={() => {}}
      onRunCommand={() => {
        invocations += 1
        return new Promise<boolean>(resolve => { attempts.push({ resolve }) })
      }}
      selectionActive={false}
      controllerRef={controllerRef}
    />
  )
  const app = await render(
    promptTree(),
    { stdin: stdin as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const screen = screenOf(terminal, ROWS)
  await sleep(300)

  stdin.write('/vision first')
  await settled(() => screen.text().includes('/vision first'))
  stdin.write('\r')
  check('prompt: async registry command keeps its submitted draft visible',
    await settled(() => invocations === 1) && screen.text().includes('/vision first'),
    screen.text())
  await sleep(100)
  stdin.write('\r')
  await sleep(100)
  check('prompt: duplicate Enter does not invoke the same pending attempt twice',
    invocations === 1, `invocations=${invocations}`)

  controllerRef.current?.append(' edited')
  check('prompt: host injection edits the pending draft synchronously',
    await settled(() => screen.text().includes('/vision first edited')), screen.text())
  await sleep(100)
  stdin.write('\r')
  check('prompt: an edited pending draft may start a distinct command attempt',
    await settled(() => invocations === 2), `invocations=${invocations}`)

  attempts[0]!.resolve(true)
  await sleep(100)
  check('prompt: late success cannot clear text appended after its snapshot',
    screen.text().includes('/vision first edited'), screen.text())
  attempts[1]!.resolve(true)
  check('prompt: the matching latest success clears exactly its own draft',
    await settled(() => !screen.text().includes('/vision first edited')), screen.text())

  stdin.write('/vision [Image #99]')
  await settled(() => screen.text().includes('[Image #99]'))
  stdin.write('\r')
  await settled(() => invocations === 3)
  attempts[2]!.resolve(false)
  await sleep(100)
  check('prompt: a rejected stale image token remains editable',
    screen.text().includes('/vision [Image #99]'), screen.text())

  controllerRef.current?.clear()
  await settled(() => !screen.text().includes('[Image #99]'))
  stdin.write('/vision session-bound')
  await settled(() => screen.text().includes('/vision session-bound'))
  stdin.write('\r')
  await settled(() => invocations === 4)
  generation += 1
  app.rerender(promptTree())
  attempts[3]!.resolve(true)
  await sleep(100)
  check('prompt: a previous-session success cannot consume the retained draft',
    screen.text().includes('/vision session-bound'), screen.text())

  await app.unmount()
  terminal.dispose()
}

// --- Prompt async-paste fence: an old continuation cannot edit new draft --
{
  const pastedImagePath = `${process.env.HOME}/composer.png`
  const secondImagePath = `${process.env.HOME}/composer-b.png`
  const oversizedImagePath = `${process.env.HOME}/oversized.png`
  const directoryImagePath = `${process.env.HOME}/not-a-file.png`
  writeFileSync(pastedImagePath, png)
  writeFileSync(secondImagePath, png)
  writeFileSync(oversizedImagePath, Buffer.alloc(1024 * 1024 + 1))
  mkdirSync(directoryImagePath, { recursive: true })
  const stageResolvers: Array<(handle: { stageId: string }) => void> = []
  const resolveStage = (handle: { stageId: string }): void => {
    const resolve = stageResolvers.shift()
    assert(resolve !== undefined, `no staged-image promise waiting for ${handle.stageId}`)
    resolve(handle)
  }
  let stageCalls = 0
  let generation = 0
  const submitted: string[] = []
  const discarded: string[] = []
  let localCommandCalls = 0
  const channel = makeChannel()
  channel.stagedImageGeneration = () => generation
  channel.submit = (text: string) => { submitted.push(text) }
  channel.stageComposerImage = () => new Promise(resolve => {
    stageCalls += 1
    stageResolvers.push(resolve)
  })
  channel.discardStagedImage = (stageId: string) => { discarded.push(stageId) }
  channel.hasStagedImage = () => true
  channel.pushLocal = () => { localCommandCalls += 1 }

  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen>
      <Chat
        channel={channel as never}
        questionStore={new QuestionStore()}
        onExit={() => {}}
        fullscreen
      />
    </AlternateScreen>,
    { stdin: stdin as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const screen = screenOf(terminal, ROWS)
  await sleep(500)

  stdin.write(`\x1b[200~${oversizedImagePath}\x1b[201~`)
  check('chat: oversized pasted paths never reach attachment staging',
    await settled(() => screen.text().includes('oversized.png')) && stageCalls === 0,
    `calls=${stageCalls}\n${screen.text()}`)
  stdin.write('\x1b')
  await settled(() => !screen.text().includes('oversized.png'))

  stdin.write(`\x1b[200~${directoryImagePath}\x1b[201~`)
  check('chat: non-regular pasted paths never reach attachment staging',
    await settled(() => screen.text().includes('not-a-file.png')) && stageCalls === 0,
    `calls=${stageCalls}\n${screen.text()}`)
  stdin.write('\x1b')
  await settled(() => !screen.text().includes('not-a-file.png'))

  // Ordinary typing belongs to the same logical draft, so a delayed paste
  // follows the live caret instead of being spuriously cancelled.
  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  check('chat: async paste reached the staging barrier',
    await settled(() => stageCalls === 1))
  stdin.write('live draft')
  resolveStage({ stageId: 'live-draft-stage' })
  check('chat: ordinary typing preserves the current draft image lease',
    await settled(() =>
      screen.text().includes('live draft') &&
      screen.text().includes('[Image #1]')),
    screen.text())
  stdin.write('\x1b')
  await settled(() => !screen.text().includes('live draft'))
  check('chat: clearing an unsent draft releases its staged capability',
    discarded.includes('live-draft-stage'), JSON.stringify(discarded))

  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  check('chat: second async paste reached the staging barrier',
    await settled(() => stageCalls === 2))
  // Stay in the same session: sending the current logical draft, rather
  // than a session-generation change, is what must revoke the old paste.
  stdin.write('old draft')
  stdin.write('\r')
  check('chat: submitting a draft advances its image lease',
    await settled(() => submitted[0] === 'old draft'))
  stdin.write('fresh draft')
  resolveStage({ stageId: 'old-draft-stage' })
  await sleep(150)
  check('chat: old paste continuation cannot mutate the next same-session draft',
    screen.text().includes('fresh draft') &&
    !screen.text().includes('[Image #') &&
    !screen.text().includes(pastedImagePath),
    screen.text())
  check('chat: stale staged capability is reclaimed immediately',
    discarded.includes('old-draft-stage'), JSON.stringify(discarded))

  // Presentation numbers reset per session, while a stale token retained in
  // the draft would still reserve its visible number in bindStagedImage.
  generation += 1
  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  check('chat: new-session paste reached the staging barrier',
    await settled(() => stageCalls === 3))
  resolveStage({ stageId: 'new-session-stage' })
  check('chat: image presentation numbering restarts in a new session',
    await settled(() => screen.text().includes('[Image #1]')), screen.text())

  // Every locally-handled slash command defaults to no composer images.
  // Admission must happen before Chat executes it, preserving both text and
  // the opaque capability instead of silently clearing the draft.
  stdin.write('\x1b')
  await settled(() => !screen.text().includes('[Image #1]'))
  stdin.write('/status ')
  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  check('chat: command-image paste reached the staging barrier',
    await settled(() => stageCalls === 4))
  resolveStage({ stageId: 'command-image-stage' })
  check('chat: command-image token bound before admission',
    await settled(() => screen.text().includes('/status') && screen.text().includes('[Image #2]')), screen.text())
  stdin.write('\r')
  await sleep(150)
  check('chat: a local command that does not accept images is not executed',
    localCommandCalls === 0, String(localCommandCalls))
  check('chat: refused command preserves its exact image draft',
    screen.text().includes('/status')
    && screen.text().includes('[Image #2]')
    && !discarded.includes('command-image-stage'),
    screen.text())

  stdin.write('\x1b')
  await settled(() => !screen.text().includes('/status'))
  check('chat: clearing the refused command releases its capability',
    discarded.includes('command-image-stage'), JSON.stringify(discarded))

  // Consecutive terminal drops are serialized through save + bind + insert.
  // The second storage call must not begin before the first visible token is
  // installed, and typing during the second save must preserve both bindings.
  generation += 1
  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  stdin.write(`\x1b[200~${secondImagePath}\x1b[201~`)
  check('chat: consecutive drops start only the first staged save',
    await settled(() => stageCalls === 5) && stageResolvers.length === 1,
    `calls=${stageCalls}, pending=${stageResolvers.length}`)
  resolveStage({ stageId: 'ordered-stage-a' })
  check('chat: second drop starts after the first token is visible',
    await settled(() => stageCalls === 6 && screen.text().includes('[Image #1]')),
    screen.text())
  stdin.write('between ')
  resolveStage({ stageId: 'ordered-stage-b' })
  check('chat: consecutive drops keep operation order and live typing',
    await settled(() => {
      const text = screen.text()
      return text.indexOf('[Image #1]') !== -1
        && text.indexOf('[Image #2]') > text.indexOf('[Image #1]')
        && text.includes('between')
    }), screen.text())

  stdin.write('\x1b')
  await settled(() => !screen.text().includes('[Image #1]'))

  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  check('chat: unmount-race paste reached the staging barrier',
    await settled(() => stageCalls === 7))
  await app.unmount()
  resolveStage({ stageId: 'unmounted-draft-stage' })
  check('chat: unmount revokes and reclaims a late staged capability',
    await settled(() => discarded.includes('unmounted-draft-stage')),
    JSON.stringify(discarded))
  terminal.dispose()
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-image-preview: all checks passed')
