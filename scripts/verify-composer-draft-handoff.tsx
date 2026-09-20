/**
 * verify-composer-draft-handoff — the unsent draft survives a composer
 * unmount, exactly, and only for its own conversation.
 *
 * Every screen that REPLACES the conversation in Chat (the session screen, the
 * tree, settings, the jobs panel, the trajectory scene) is an early return that
 * unmounts `PromptInput`. The draft therefore lives in a slot the OWNER holds
 * (`PromptDraftCache`), written by the composer as it unmounts and consumed as
 * it mounts.
 *
 * This script mounts the real composer and really unmounts it, because the
 * failure this pins is an ordering one that typing alone cannot reach: a
 * commit-time write to that slot runs BEFORE the restore effect, so the
 * composer's own empty first value erases the draft it came back for. The
 * screen-swap case in `verify-session-browser.mjs` pressed a key that opens an
 * OVERLAY and never unmounted anything, so it passed either way.
 *
 * Pinned here:
 *   1. ROUND TRIP: text and caret come back, and the caret is at the SAVED
 *      offset — typing after the return inserts at that offset, not at the end.
 *   2. OWNERSHIP: a draft is not restored into a different agent, nor into a
 *      different binding generation.
 *   3. IMAGES: the visible `[Image #N]` token and the capability behind it are
 *      captured together, and a capability the channel revoked in the meantime
 *      is not resurrected — the token degrades to ordinary text.
 *   4. EMPTY: an empty composer leaves no draft behind for the next mount.
 *
 * Run: node --import tsx/esm scripts/verify-composer-draft-handoff.tsx
 */
import { fileURLToPath } from 'node:url'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
// fileURLToPath (not URL.pathname) keeps the drive letter intact on Windows.
const home = fileURLToPath(new URL('../node_modules/.cache/dsh-tui-draft-handoff-home', import.meta.url))
process.env.HOME = home
process.env.USERPROFILE = home

import { mkdirSync, writeFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import type { ChatRow, ComposerImageRef } from '../src/dsh-adapter/channel.js'
import type { TranscriptImage } from '../src/dsh-adapter/transcript-images.js'
import type { PromptController } from '../src/components/PromptInput.js'
import type { PromptDraftCache } from '../src/components/promptDraftCache.js'
import { settled, sleep } from './lib/term-test.mjs'

mkdirSync(home, { recursive: true })

const { Terminal: XTerm } = xterm
const [{ render }, { PromptInput }, { LOCAL_COMMANDS }] = await Promise.all([
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/commands.js'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 80
const ROWS = 20

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

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function fakeImage(id: string, name: string): TranscriptImage {
  return { id, width: 16, height: 8, name, mediaType: 'image/png', async read() { return png } }
}

/** The composer's channel face, as `verify-composer-image-tokens` builds it. */
function makeChannel() {
  const staged = new Map<string, TranscriptImage>()
  const listeners = new Set<() => void>()
  let nextStage = 1
  let generation = 0
  return {
    staged,
    version: 0,
    rows: [] as ChatRow[],
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
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    submit() {},
    steer() {},
    cancel() {},
    clear() {},
    notify() {},
    stagedImageGeneration: () => generation,
    stageImage: async () => '[Image #1]',
    async stageComposerImage() {
      const stageId = `stage-${nextStage++}`
      staged.set(stageId, fakeImage(`sha256:${stageId}`, 'staged.png'))
      return { stageId }
    },
    discardStagedImage(stageId: string) { staged.delete(stageId) },
    hasStagedImage: (stageId: string) => staged.has(stageId),
    stagedImage: (stageId: string) => staged.get(stageId),
    stagedImageLimits: () => ({ maxImageBytes: 1024 * 1024, maxImagesPerMessage: 8 }),
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    /** The same shape a session switch has: new generation, capabilities gone. */
    replaceSession() {
      generation++
      this.agentBindingGeneration++
      this.version++
      staged.clear()
      for (const listener of listeners) listener()
    },
  }
}

const pastedImagePath = `${home}/atomic.png`
writeFileSync(pastedImagePath, png)

const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const stdin = new FakeStdin()
const channel = makeChannel()
const cache: PromptDraftCache = { current: null }
const controllerRef: { current: PromptController | null } = { current: null }

/** Host with a switch the test drives, standing in for Chat's early returns. */
let setComposerMounted: ((mounted: boolean) => void) | null = null
function Host() {
  const [mounted, setMounted] = React.useState(true)
  setComposerMounted = setMounted
  if (!mounted) return null
  return React.createElement(PromptInput, {
    channel: channel as never,
    draftCache: cache,
    helpOpen: false,
    onToggleHelp: () => {},
    onRunCommand: () => false,
    selectionActive: false,
    controllerRef: controllerRef as never,
  })
}

const app = await render(React.createElement(Host), {
  stdin: stdin as never,
  stdout: stdout as never,
  stderr: new FakeStderr() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
await sleep(400) // 固定窗:探针 等首帧与控制器发布，无单一可轮询锚点

const composerText = (): string => controllerRef.current?.text?.() ?? '<no composer>'
const mounted = (): boolean => controllerRef.current !== null
const remount = async (): Promise<void> => {
  setComposerMounted?.(true)
  await settled(() => mounted())
  await sleep(150) // 固定窗:探针 认领 effect 在首帧提交之后才跑
}

// ── 1. Round trip: text, caret offset, and insert-at-caret after the return ─
console.log('round trip:')
stdin.write('hello')
check('the composer takes typed text', await settled(() => composerText() === 'hello'), composerText())
stdin.write('\x1b[D\x1b[D') // caret between "he" and "llo"
await sleep(150) // 固定窗:pacing 方向键步进无单一可轮询锚点
setComposerMounted?.(false)
await settled(() => !mounted())
check('unmounting captures the draft in the owner slot', cache.current !== null, JSON.stringify(cache.current))
check('the captured draft carries the text', cache.current?.value === 'hello', JSON.stringify(cache.current?.value))
check('and the caret OFFSET, not the end of the text', cache.current?.cursor === 3, String(cache.current?.cursor))
check('and it is owned by the agent it was typed into',
  cache.current?.ownerAgentId === 'probe', String(cache.current?.ownerAgentId))

await remount()
check('the draft comes back on remount', composerText() === 'hello', composerText())
stdin.write('X')
// Inserting at offset 3 of "hello" is "hel" + "X" + "lo" — the saved caret,
// not the end of the text (which would have produced "helloX").
check('typing after the return inserts at the SAVED caret',
  await settled(() => composerText() === 'helXlo'), composerText())

// ── 2. Ownership: neither another agent nor another generation may inherit it ─
console.log('ownership:')
setComposerMounted?.(false)
await settled(() => !mounted())
check('the second unmount captured the edited draft',
  cache.current?.value === 'helXlo', JSON.stringify(cache.current?.value))
channel.agentId = 'someone-else'
await remount()
check('a different AGENT does not restore the draft', composerText() === '', composerText())
check('and the refused snapshot is consumed, not left behind', cache.current === null, JSON.stringify(cache.current))

setComposerMounted?.(false)
await settled(() => !mounted())
check('an empty composer leaves no draft behind', cache.current === null, JSON.stringify(cache.current))
channel.agentId = 'probe'
await remount()
stdin.write('draft two')
check('the composer takes a second draft', await settled(() => composerText() === 'draft two'), composerText())
setComposerMounted?.(false)
await settled(() => !mounted())
channel.replaceSession() // same agent id, new binding generation
await remount()
check('a different GENERATION does not restore the draft', composerText() === '', composerText())

// ── 3. Images: the token and the capability travel together ────────────────
// A visible `[Image #N]` is only a label. What makes it an attachment is the
// stageId behind it, and that has to be in the snapshot — otherwise the draft
// comes back looking right and submits with no image at all.
console.log('images:')
setComposerMounted?.(false)
await settled(() => !mounted())
check('the refused generation left no draft behind', cache.current === null, JSON.stringify(cache.current))
await remount()
stdin.write('\x1b[200~' + pastedImagePath + '\x1b[201~')
await settled(() => /\[Image #\d+\]/.test(composerText()))
const withToken = composerText()
check('pasting stages an image token', /\[Image #\d+\]/.test(withToken), JSON.stringify(withToken))
check('the composer reports the live binding', (controllerRef.current?.previewImages?.() ?? []).length === 1,
  JSON.stringify(controllerRef.current?.previewImages?.()))

setComposerMounted?.(false)
await settled(() => !mounted())
const captured = cache.current
check('the snapshot carries the token to stageId pair',
  captured !== null && captured.images.length === 1 && captured.images[0]![0] === '[Image #1]'
  && channel.hasStagedImage(captured.images[0]![1]),
  JSON.stringify(captured?.images))

// The capability is STILL live here, so the restored draft must come back as a
// real attachment. Asserting only the capture above would let a restore that
// always drops image bindings pass.
await remount()
check('a LIVE binding is restored, not just the visible token',
  /\[Image #1\]/.test(composerText()) && (controllerRef.current?.previewImages?.() ?? []).length === 1,
  JSON.stringify(controllerRef.current?.previewImages?.()))

// Now the channel revokes the capability while the composer is away (a session
// switch does exactly this). The token may stay as text; the binding may not
// come back, and it must not be re-derived from the number in the label.
setComposerMounted?.(false)
await settled(() => !mounted())
channel.staged.clear()
await remount()
check('the visible token survives as ordinary text',
  /\[Image #1\]/.test(composerText()), JSON.stringify(composerText()))
check('but a revoked capability is NOT resurrected',
  (controllerRef.current?.previewImages?.() ?? []).length === 0,
  JSON.stringify(controllerRef.current?.previewImages?.()))

app.unmount()
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ncomposer draft hand-off checks passed')
