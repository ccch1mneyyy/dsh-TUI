/**
 * verify-composer-image-tokens — staged `[Image #N]` tokens are atomic in
 * the composer.
 *
 * The caret never rests inside a staged token: ←/→ step over it, Backspace
 * at its end / Delete at its start / Ctrl+W remove it whole, a selection
 * edge inside it grows to cover it, and a click puts the caret at its
 * start. It renders as a chip in the theme accent and inverts whole when
 * the caret sits at its start (the selected-chip look). A raw token typed
 * without a capability stays ordinary text.
 * Vim deletions and undo preserve attachment bindings through submission;
 * clearing, session replacement, undo eviction and unmount release them.
 *
 * Colour is on (FORCE_COLOR=3): the chip colour and the inverse caret are
 * chalk-level styling that verify-image-preview's colourless run strips.
 *
 * Run: node --import tsx/esm scripts/verify-composer-image-tokens.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.HOME = new URL('../node_modules/.cache/dsh-tui-composer-tokens-home', import.meta.url).pathname
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

import { mkdirSync, writeFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import sharp from 'sharp'
import type { ChatRow, ComposerImageRef } from '../src/dsh-adapter/channel.js'
import type { TranscriptImage } from '../src/dsh-adapter/transcript-images.js'
import { settled, sleep } from './lib/term-test.mjs'

mkdirSync(process.env.HOME, { recursive: true })

const { Terminal: XTerm } = xterm
const [
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { TuiStatusStore },
  { LOCAL_COMMANDS },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/status.js'),
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
const ROWS = 30

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

const png = new Uint8Array(await sharp({
  create: { width: 16, height: 8, channels: 4, background: { r: 40, g: 90, b: 200, alpha: 1 } },
}).png().toBuffer())

function fakeImage(id: string, name: string): TranscriptImage {
  return { id, width: 16, height: 8, name, mediaType: 'image/png', async read() { return png } }
}

function makeChannel() {
  const staged = new Map<string, TranscriptImage>()
  const submissions: Array<{ text: string; images: readonly ComposerImageRef[] }> = []
  const listeners = new Set<() => void>()
  let nextStage = 1
  let generation = 0
  return {
    staged,
    submissions,
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
    submit(text: string, images: readonly ComposerImageRef[] = []) {
      submissions.push({ text, images })
    },
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
    replaceSession() {
      generation++
      this.version++
      staged.clear()
      for (const listener of listeners) listener()
    },
  }
}

const pastedImagePath = `${process.env.HOME}/atomic.png`
writeFileSync(pastedImagePath, png)
const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const stdin = new FakeStdin()
const channel = makeChannel()
const app = await render(
  <AlternateScreen>
    <Chat
      channel={channel as never}
      questionStore={new QuestionStore()}
      extensionStatus={new TuiStatusStore()}
      onExit={() => {}}
      fullscreen
    />
  </AlternateScreen>,
  { stdin: stdin as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
)
const lines = (): string[] => Array.from(
  { length: ROWS },
  (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
)
const text = (): string => lines().join('\n')
const find = (needle: string): { row: number; col: number } | null => {
  const all = lines()
  for (let row = 0; row < all.length; row++) {
    const col = all[row]!.indexOf(needle)
    if (col !== -1) return { row, col }
  }
  return null
}
await sleep(600)

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const END = '\x1b[F'
const BACKSPACE = '\x7f'
const DELETE = '\x1b[3~'
const CTRL_W = '\x17'
const cellAt = (col: number, row: number) => terminal.buffer.active.getLine(row)?.getCell(col)
const inverseAt = (col: number, row: number): boolean => (cellAt(col, row)?.isInverse() ?? 0) !== 0
const tokensOnScreen = (): string[] => [...text().matchAll(/\[Image #\d+\]/gu)].map(m => m[0])
const wholeInverse = (pos: { col: number; row: number }, token: string): boolean =>
  Array.from({ length: token.length }, (_, i) => inverseAt(pos.col + i, pos.row)).every(Boolean)
const noneInverse = (pos: { col: number; row: number }, token: string): boolean =>
  Array.from({ length: token.length }, (_, i) => inverseAt(pos.col + i, pos.row)).every(v => !v)
const noTokenFragment = (): boolean => !text().includes('Image #')
const draftIs = (pattern: RegExp): boolean => pattern.test(text())
const click = (col: number, row: number, button = 0): void => {
  stdin.write(`\x1b[<${button};${col + 1};${row + 1}M`)
  stdin.write(`\x1b[<${button};${col + 1};${row + 1}m`)
}
/** Paste the image path and return the token it minted. A paste inserts
 *  `[Image #N] ` (token + one space) at the caret. */
const paste = async (): Promise<string> => {
  const before = new Set(tokensOnScreen())
  stdin.write(`\x1b[200~${pastedImagePath}\x1b[201~`)
  let minted = ''
  await settled(() => {
    const fresh = tokensOnScreen().filter(token => !before.has(token))
    if (fresh.length === 0) return false
    minted = fresh[0]!
    return true
  })
  return minted
}

stdin.write('a ')
await settled(() => find('❯ a ') !== null)
const t1 = await paste()
stdin.write('b')
await settled(() => text().includes(`${t1} b`))
const p1 = find(t1)!
check('chip: a staged token renders in the accent colour, not the text colour',
  (() => {
    const chip = cellAt(p1.col, p1.row)
    const plain = cellAt(p1.col - 2, p1.row)
    return chip !== undefined && plain !== undefined
      && !chip.isFgDefault() && chip.getFgColor() !== plain.getFgColor()
  })(),
  JSON.stringify({ p1, chip: cellAt(p1.col, p1.row)?.getFgColor(), plain: cellAt(p1.col - 2, p1.row)?.getFgColor() }))

// ← twice from after "b": the caret sits at the token's end and the space
// after the token is the caret cell.
stdin.write(LEFT)
stdin.write(LEFT)
check('caret: at the token end the token is plain and the next cell is the caret',
  await settled(() => noneInverse(p1, t1) && inverseAt(p1.col + t1.length, p1.row)), text())
stdin.write(LEFT)
check('caret: ← from the token end jumps to its start and inverts the whole token',
  await settled(() => wholeInverse(p1, t1)), text())
stdin.write(RIGHT)
check('caret: → from the token start jumps to its end',
  await settled(() => noneInverse(p1, t1) && inverseAt(p1.col + t1.length, p1.row)), text())
stdin.write(BACKSPACE)
check('delete: Backspace at the token end removes the whole token',
  await settled(() => !text().includes(t1) && noTokenFragment() && draftIs(/❯ a +b/u)), text())

// The caret sits where the token was; the next paste lands there and the
// caret ends after the pasted trailing space, so ← ← reaches the start.
const t2 = await paste()
stdin.write(LEFT)
stdin.write(LEFT)
const p2 = find(t2)!
check('caret: ← ← after a paste selects the fresh token',
  await settled(() => wholeInverse(p2, t2)), text())
stdin.write(DELETE)
check('delete: Delete at the token start removes the whole token',
  await settled(() => !text().includes(t2) && noTokenFragment() && draftIs(/❯ a +b/u)), text())

const t3 = await paste()
stdin.write(CTRL_W)
check('delete: Ctrl+W after the token removes the whole token, not just the text after its space',
  await settled(() => !text().includes(t3) && noTokenFragment() && draftIs(/❯ a +b/u)), text())

// Selection: click before "a", then Shift+click inside the token — the
// selection grows to the token's end and Backspace removes it whole.
const t4 = await paste()
const p4 = find(t4)!
click(p4.col - 2, p4.row)
await sleep(120)
click(p4.col + 4, p4.row, 4)
check('select: a selection edge inside the token grows to cover it',
  await settled(() => wholeInverse(p4, t4) && inverseAt(p4.col - 2, p4.row)), text())
stdin.write(BACKSPACE)
check('select: deleting that selection removes the whole token',
  await settled(() => !text().includes(t4) && noTokenFragment() && draftIs(/❯ +b/u) && !draftIs(/❯ a/u)),
  text())

// A click on a staged token puts the caret at its start: the token is the
// caret cluster and highlights whole (and the preview opens).
const t5 = await paste()
const p5 = find(t5)!
await sleep(600)
click(p5.col + 3, p5.row)
check('click: clicking a staged token opens the preview and selects the token',
  await settled(() => text().includes(' — PNG · ') && wholeInverse(p5, t5)), text())
stdin.write('\x1b')
check('peek: Esc dismisses the caret preview',
  await settled(() => !text().includes(' — PNG · ')), text())
const previewOpen = (): boolean => text().includes(' — PNG · ')
const title5 = t5.slice(1, -1)

// The cell just after the token is not "on" it: the token is plain there
// and no preview shows (only the selected, inverted token previews).
stdin.write(RIGHT)
await sleep(200)
check('peek: the caret just after the token shows no preview (token not selected)',
  !previewOpen() && noneInverse(p5, t5) && inverseAt(p5.col + t5.length, p5.row), text())
// Leaving reset the dismissal: ← back to the start shows it again.
stdin.write(LEFT)
check('peek: ← back to the token start selects it and shows its preview again',
  await settled(() => previewOpen() && text().includes(title5) && wholeInverse(p5, t5)), text())
// The keyboard stays with the prompt while the preview is up: typing at
// the token's start inserts before it, and the caret is still on the token.
stdin.write('x')
check('peek: typing before the token keeps the caret on it and the preview open',
  await settled(() => text().includes(`x${t5}`) && previewOpen()), text())
const p5x = find(t5)!
stdin.write(LEFT)
check('peek: ← off the token closes the preview (arrows keep moving the caret)',
  await settled(() => !previewOpen() && inverseAt(p5x.col - 1, p5x.row)), text())
stdin.write(RIGHT)
check('peek: → back onto the token reopens it',
  await settled(() => previewOpen() && wholeInverse(p5x, t5)), text())
stdin.write('\x1b')
await settled(() => !previewOpen())
// Past the double-click window: the previous click on this token was one
// column away, and a fast second click would select a word instead.
await sleep(600)
click(p5x.col + 3, p5x.row)
check('peek: a click on a dismissed token shows its preview again',
  await settled(() => previewOpen() && wholeInverse(p5x, t5)), text())
stdin.write('\x1b')
await settled(() => !previewOpen())

// A raw token with no capability is ordinary text: ← steps inside it and
// it takes the text colour.
stdin.write(END)
stdin.write('[Image #9]')
await settled(() => find('[Image #9]') !== null)
stdin.write(LEFT)
const raw = find('[Image #9]')!
check('raw: a token without a capability is ordinary text (caret steps inside it)',
  await settled(() => inverseAt(raw.col + '[Image #9]'.length - 1, raw.row) && !inverseAt(raw.col, raw.row)),
  text())
check('raw: a token without a capability takes the text colour',
  cellAt(raw.col, raw.row)?.getFgColor() === cellAt(p5.col - 2, p5.row)?.getFgColor(), text())

// Vim edits must carry the same atomic spans as ordinary deletion. Check
// the submitted capability after undo, not just the restored token's text.
stdin.write('\x03')
await settled(() => noTokenFragment())
stdin.write('/vim\r')
check('vim: enabled in INSERT', await settled(() => text().includes('❯ INSERT')), text())
const lastStageId = (): string => [...channel.staged.keys()].at(-1)!
const vimDraft = (): string =>
  (lines().find(line => line.includes('❯ NORMAL'))?.split('❯ NORMAL')[1] ?? '\0')
    .replace(/⛶\s*$/u, '').trim()
const enterNormal = async (): Promise<void> => {
  stdin.write('\x1b')
  check('vim: entered NORMAL', await settled(() => text().includes('❯ NORMAL')), text())
}
const selectToken = async (token: string): Promise<void> => {
  stdin.write('\x1b[H')
  check('vim: caret selects the token', await settled(() => {
    const pos = find(token)
    return pos !== null && wholeInverse(pos, token)
  }), text())
}
for (const command of ['x', 'X', 'dw', 'dd', 'd$', 'd0', 'd^']) {
  const token = await paste()
  const stageId = lastStageId()
  stdin.write('tail')
  await enterNormal()
  await selectToken(token)
  if (command === 'X' || command === 'd0' || command === 'd^') stdin.write(RIGHT)
  stdin.write(command)
  const remaining = command === 'dd' || command === 'd$' ? '' : 'tail'
  check(`vim ${command}: deletes the whole token`,
    await settled(() => vimDraft() === remaining && noTokenFragment()), text())
  check(`vim ${command}: undo retains the attachment`, channel.hasStagedImage(stageId))
  stdin.write('u')
  check(`vim ${command}: undo restores the draft`,
    await settled(() => vimDraft() === `${token} tail`), text())
  const before = channel.submissions.length
  stdin.write('\r')
  await settled(() => channel.submissions.length > before)
  check(`vim ${command}: restored attachment reaches submit`,
    channel.submissions[before]?.images.some(ref => ref.token === token && ref.stageId === stageId) === true,
    JSON.stringify(channel.submissions[before]))
  stdin.write('i')
  await settled(() => text().includes('❯ INSERT'))
}

// `$x` deletes the last grapheme of a line; a token ending that line is
// still one atom. Undo restores its binding just as at the token's start.
const endToken = await paste()
const endStage = lastStageId()
stdin.write(BACKSPACE) // remove the paste's trailing space
await enterNormal()
stdin.write('x')
check('vim x at line end: removes the whole token',
  await settled(() => vimDraft() === '' && noTokenFragment()), text())
stdin.write('u')
check('vim x at line end: undo restores the attachment',
  await settled(() => text().includes(endToken)) && channel.hasStagedImage(endStage), text())
stdin.write('x')
await settled(noTokenFragment)
stdin.write('i tail')
await settled(() => text().includes('❯ INSERT tail'))
await enterNormal()
stdin.write('\x03')
check('vim clear: releases attachments retained only by undo',
  await settled(() => !channel.hasStagedImage(endStage)))
stdin.write('ui')
await settled(() => text().includes('❯ INSERT'))
check('vim clear: cannot undo into the discarded draft', noTokenFragment(), text())

const evictedToken = await paste()
const evictedStage = lastStageId()
stdin.write('z'.repeat(105))
await enterNormal()
await selectToken(evictedToken)
stdin.write('x')
await settled(noTokenFragment)
check('vim eviction: deleted image starts retained', channel.hasStagedImage(evictedStage))
stdin.write('x'.repeat(100))
check('vim eviction: dropping the last snapshot releases its image',
  await settled(() => !channel.hasStagedImage(evictedStage)))
stdin.write('\x03')
await settled(() => /❯ NORMAL\s*$/mu.test(text()))

stdin.write('i')
const sessionToken = await paste()
await enterNormal()
await selectToken(sessionToken)
stdin.write('x')
await settled(noTokenFragment)
channel.replaceSession()
stdin.write('ui')
await settled(() => text().includes('❯ INSERT'))
check('vim session replacement: undo cannot restore an old session draft', noTokenFragment(), text())

const unmountToken = await paste()
const unmountStage = lastStageId()
await enterNormal()
await selectToken(unmountToken)
stdin.write('x')
await settled(noTokenFragment)
await app.unmount()
check('vim unmount: releases images retained only by undo', !channel.hasStagedImage(unmountStage))
terminal.dispose()

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-composer-image-tokens: all checks passed')
