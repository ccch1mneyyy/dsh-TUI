/**
 * Plugin `@`-mention providers (`ctx.tuiMentions`) regression.
 *
 * Part A — admission and queries, against a real Cordis composition: shape
 * refusals (id/title/complete), duplicate ids, the 4-per-activation and
 * 16-total caps, root callers, the returned disposer and fiber-dispose
 * cleanup, row sanitization (control/bidi/ANSI, cell caps, single line,
 * 200-char insertText, embedded `@` mention tokens, 50-row cap, dedupe,
 * malformed rows), registration order, the 300 ms budget, abort propagation,
 * and throwing/rejecting providers that must cost only their own rows.
 *
 * Part B — `mergeMentionCandidates`: identity without providers, fuzzy-score
 * placement that keeps file order, ties to files, unmatched rows last.
 *
 * Part C — the real PromptInput through `@xterm/headless`: the popup with no
 * provider (and with an empty host) is the file-only popup, frame for frame;
 * provider rows render beside files under the 提及 title; Enter inserts the
 * plain `insertText` and submit sends it verbatim; each keystroke aborts the
 * previous provider call.
 *
 * Run: node --import tsx/esm scripts/verify-mention-providers.tsx
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// HOME/USERPROFILE must be isolated before any src import (paths.ts captures
// DATA_DIR at module load).
const fakeHome = mkdtempSync(join(tmpdir(), 'verify-mention-providers-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'
process.env.FORCE_COLOR = '3'

const [
  { Context },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, Box },
  mentionModule,
  { mergeMentionCandidates },
  { PromptInput },
  { completeCommands },
  { settle, settled, viewportLines },
  instances,
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/dsh-adapter/mention-providers.js'),
  import('../src/utils/fileSuggestions.js'),
  import('../src/components/PromptInput.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/instances.js').then(module => module.default),
])

const { TuiMentionRuntime, getHostMentions, MENTION_PROVIDER_LIMITS } = mentionModule
type Provider = import('../src/dsh-adapter/mention-providers.js').TuiMentionProvider
type FileCandidate = import('../src/utils/fileSuggestions.js').FileCandidate
type ProvidedMentionCandidate = import('../src/utils/fileSuggestions.js').ProvidedMentionCandidate

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

// ── Part A: admission and queries ───────────────────────────────────────────

const root = new Context()
root.logger.exporter({ colors: false, levels: { default: 4 }, export(): void {} })
await root.plugin(TuiMentionRuntime)
const host = getHostMentions(root.get('tuiMentions'))
if (host === undefined) throw new Error('tuiMentions host facade unavailable')

const signal = (): AbortSignal => new AbortController().signal
const provider = (id: string, rows: Provider['complete'] = () => [{ label: id, insertText: id }]): Provider =>
  ({ id, title: id, complete: rows })

/** Mount one plugin activation; `run` executes inside its fiber. */
async function activate(run: (ctx: Context) => void) {
  const fiber = root.inject(['tuiMentions'], (pluginCtx: Context) => {
    run(pluginCtx)
  })
  await fiber
  return fiber
}

/** Run `register` in a fresh activation and report what it threw. */
async function registerError(candidate: unknown): Promise<string | undefined> {
  let message: string | undefined
  const fiber = await activate(ctx => {
    try {
      ctx.tuiMentions.register(candidate as Provider)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
  })
  await fiber.dispose()
  return message
}

check('refuses a malformed id', (await registerError(provider('Bad Id')))?.includes('invalid TUI mention provider id') === true)
check('refuses a missing complete()', (await registerError({ id: 'x', title: 'x' }))?.includes('complete()') === true)
check('refuses an empty title', (await registerError({ id: 'x', title: '‮  \n', complete: () => [] }))?.includes('title') === true)
check('refused registrations leave nothing behind', host.size() === 0, String(host.size()))

let rootRejected = false
await activate(ctx => {
  try {
    ctx.root.get('tuiMentions')?.register(provider('root-leak'))
  } catch {
    rootRejected = true
  }
})
check('root caller is rejected', rootRejected && host.size() === 0, String(host.size()))

// Disposer + fiber cleanup.
let dispose: (() => void) | undefined
const owned = await activate(ctx => {
  dispose = ctx.tuiMentions.register(provider('owned'))
  ctx.tuiMentions.register(provider('owned-two'))
})
check('registration is visible to the host', host.size() === 2, String(host.size()))
let duplicate = ''
const dupFiber = await activate(ctx => {
  try {
    ctx.tuiMentions.register(provider('owned'))
  } catch (error) {
    duplicate = String(error)
  }
})
await dupFiber.dispose()
check('duplicate id is refused', duplicate.includes('already registered'), duplicate)
dispose!()
check('returned disposer removes only its provider', host.size() === 1, String(host.size()))
await owned.dispose()
check('fiber dispose removes the rest', host.size() === 0, String(host.size()))

// Per-activation cap.
let capMessage = ''
const capped = await activate(ctx => {
  for (let index = 0; index <= MENTION_PROVIDER_LIMITS.perActivation; index += 1) {
    try {
      ctx.tuiMentions.register(provider(`cap-${index}`))
    } catch (error) {
      capMessage = String(error)
    }
  }
})
check('per-activation cap is 4', host.size() === 4 && capMessage.includes('per plugin'), `${host.size()} ${capMessage}`)
await capped.dispose()

// Total cap across activations.
const fibers = []
for (let group = 0; group < 4; group += 1) {
  fibers.push(await activate(ctx => {
    for (let index = 0; index < 4; index += 1) ctx.tuiMentions.register(provider(`total-${group}-${index}`))
  }))
}
const totalError = await registerError(provider('total-overflow'))
check('host-wide cap is 16', host.size() === 16 && totalError?.includes('capped at 16') === true, `${host.size()} ${totalError}`)
for (const fiber of fibers) await fiber.dispose()
check('every capped activation cleaned up', host.size() === 0, String(host.size()))

// Sanitization.
const longLabel = '长'.repeat(60)
const rows = await (async () => {
  const fiber = await activate(ctx => {
    ctx.tuiMentions.register({
      id: 'sanitize',
      title: 'Blender‮\x1b[31m',
      complete: () => [
        { label: 'Cube\x1b[31m\n‮A', detail: 'MESH\t\x00', insertText: 'Cube\n(Blender)' },
        { label: longLabel, detail: 'd'.repeat(60), insertText: 'Long' },
        { label: 'too long', insertText: 'x'.repeat(201) },
        { label: 'mention', insertText: 'see @src/a.ts' },
        { label: 'email ok', insertText: 'a@b.c' },
        { label: '', insertText: 'no label' },
        { label: 'no insert', insertText: '' },
        null,
        'row',
        { label: 'Cube\x1b[31m\n‮A', detail: 'dupe', insertText: 'Cube\n(Blender)' },
        Object.defineProperty({ insertText: 'getter' }, 'label', { get() { throw new Error('boom') }, enumerable: true }),
      ] as never,
    })
  })
  const result = await host.complete('', signal())
  await fiber.dispose()
  return result
})()
const cube = rows.find(row => row.insertText === 'Cube (Blender)')
check('title is sanitized (bidi + ANSI stripped)', cube?.section === 'Blender', JSON.stringify(cube?.section))
check('label is single-line and stripped', cube?.label === 'Cube A', JSON.stringify(cube?.label))
check('detail strips control characters', cube?.detail === 'MESH', JSON.stringify(cube?.detail))
check('insertText collapses to one line', cube !== undefined)
const long = rows.find(row => row.insertText === 'Long')
check('label is capped at 80 cells with an ellipsis', long?.label.endsWith('…') === true && long.label.length < longLabel.length, long?.label)
check('detail is capped at 40 cells', long?.detail !== undefined && long.detail.length <= 40, long?.detail)
check('insertText over 200 chars is dropped', !rows.some(row => row.label === 'too long'))
check('insertText carrying an @ mention token is dropped', !rows.some(row => row.label === 'mention'))
check('a mid-token @ (email) is plain text and kept', rows.some(row => row.insertText === 'a@b.c'))
check('empty label / empty insertText rows are dropped', !rows.some(row => row.insertText === 'no label' || row.label === 'no insert'))
check('malformed and duplicate rows are skipped; a throwing row costs only itself', rows.length === 3, JSON.stringify(rows.map(row => row.label)))

// Row cap and order.
{
  const many = await activate(ctx => {
    ctx.tuiMentions.register(provider('first', () => Array.from({ length: 80 }, (_, index) => ({ label: `r${index}`, insertText: `r${index}` }))))
    ctx.tuiMentions.register(provider('second'))
  })
  const result = await host.complete('', signal())
  check('rows are capped at 50 per provider', result.filter(row => row.providerId === 'first').length === 50)
  check('providers answer in registration order', result.at(-1)?.providerId === 'second' && result[0]?.providerId === 'first')
  check('rows carry kind "provided" and stable ids', result.every(row => row.kind === 'provided' && row.id.startsWith(`${row.providerId}\u0000`)))
  await many.dispose()
}

// Failures, timeout, abort.
{
  let hungSignal: AbortSignal | undefined
  let abortedSignal: AbortSignal | undefined
  const fiber = await activate(ctx => {
    ctx.tuiMentions.register(provider('throws', () => { throw new Error('sync boom') }))
    ctx.tuiMentions.register(provider('rejects', () => Promise.reject(new Error('async boom'))))
    ctx.tuiMentions.register(provider('hangs', (_query, providerSignal) => {
      hungSignal = providerSignal
      return new Promise(() => undefined)
    }))
    ctx.tuiMentions.register(provider('healthy', query => [{ label: `ok:${query}`, insertText: `ok ${query}` }]))
  })
  const started = Date.now()
  const result = await host.complete('cu', signal())
  const elapsed = Date.now() - started
  check('throwing / rejecting / hanging providers contribute nothing', result.length === 1 && result[0]?.providerId === 'healthy', JSON.stringify(result.map(row => row.providerId)))
  check('the healthy provider received the query', result[0]?.label === 'ok:cu')
  check('a hanging provider is cut at the 300 ms budget', elapsed >= MENTION_PROVIDER_LIMITS.timeoutMs - 20 && elapsed < MENTION_PROVIDER_LIMITS.timeoutMs + 400, `${elapsed}ms`)
  check('the timed-out call sees its signal aborted', hungSignal?.aborted === true)
  await fiber.dispose()

  const abortFiber = await activate(ctx => {
    ctx.tuiMentions.register(provider('abortable', (_query, providerSignal) => {
      abortedSignal = providerSignal
      return new Promise(resolve => setTimeout(() => resolve([{ label: 'late', insertText: 'late' }]), 50))
    }))
  })
  const controller = new AbortController()
  const pending = host.complete('', controller.signal)
  controller.abort()
  const aborted = await pending
  check('an aborted query aborts the provider call and returns nothing', abortedSignal?.aborted === true && aborted.length === 0)
  check('an already-aborted query skips providers', (await host.complete('', AbortSignal.abort())).length === 0)
  await abortFiber.dispose()
}

// ── Part B: merge ───────────────────────────────────────────────────────────

const fileRow = (path: string, score: number): FileCandidate => ({ id: path, path, displayPath: path, name: path, kind: 'file', score })
const providedRow = (label: string): ProvidedMentionCandidate => ({
  id: `p\u0000${label}`, kind: 'provided', providerId: 'p', section: 'P', label, insertText: label,
})
{
  const files = [fileRow('src/cube.ts', 23.8), fileRow('docs/curve.md', 10)]
  check('no provider rows ⇒ the file list itself', mergeMentionCandidates(files, [], 'cu') === files)
  const merged = mergeMentionCandidates(files, [providedRow('Cube'), providedRow('Light'), providedRow('Curve')], 'cu')
  check('a provider row that outscores files goes first; files keep their order; unmatched rows go last',
    merged.map(row => row.id).join(',') === 'p\u0000Cube,p\u0000Curve,src/cube.ts,docs/curve.md,p\u0000Light',
    merged.map(row => (row.kind === 'provided' ? row.label : row.path)).join(','))
  const tie = mergeMentionCandidates([fileRow('a', 0)], [providedRow('b')], '')
  check('a tie goes to the file', tie[0]?.kind === 'file')
}

// ── Part C: PromptInput ─────────────────────────────────────────────────────

const COLS = 72
const ROWS = 24
const FILES: readonly FileCandidate[] = [fileRow('src/main.ts', 30), fileRow('src/cube.ts', 20)]

function makeChannel() {
  const submitted: string[] = []
  return {
    working: false,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: [],
    commandCompletions: (input: string) => completeCommands(input, []),
    notifications: [],
    pending: [],
    contextWindow: undefined,
    notify() {},
    submit(text: string) { submitted.push(text) },
    steer() {},
    removePending() { return false },
    cancel() {},
    interruptAndDeliver() { return 0 },
    listFiles: async () => FILES.map(file => file.path),
    listFileCandidates: async () => FILES,
    submitted,
  }
}

async function boot(mentionProviders?: Parameters<typeof PromptInput>[0]['mentionProviders']) {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const frames: string[] = []
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      frames.push(String(chunk))
      term.write(String(chunk), callback)
    },
  }), { columns: COLS, rows: ROWS, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback() } }), { isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true })
  Object.assign(stdin, { setRawMode: () => stdin, ref: () => stdin, unref: () => stdin })
  const channel = makeChannel()
  const tree = React.createElement(
    AlternateScreen,
    null,
    React.createElement(
      Box,
      { flexDirection: 'column', height: '100%' },
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(PromptInput, {
        channel: channel as never,
        ...(mentionProviders === undefined ? {} : { mentionProviders }),
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => true,
        selectionActive: false,
      }),
    ),
  )
  const instance = await render(tree, { stdout: stdout as never, stderr: stderr as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false })
  const ink = instances.get(stdout as never)
  instances.set(process.stdout, ink)
  instance.rerender(tree)
  ink?.setAltScreenActive(true, true)
  return { stdin, channel, instance, lines: () => viewportLines(term, ROWS), frames: () => frames.join('') }
}

const cardRows = (lines: readonly string[]): string[] => lines.filter(line => /^[╭│╰]/.test(line))

/** Open the `@` popup and return the settled screen. */
async function openAt(app: Awaited<ReturnType<typeof boot>>): Promise<string[]> {
  app.stdin.write('@')
  // The whole card (title row through the last file row) is one frame.
  await settle(() => {
    const card = cardRows(app.lines())
    return card.some(line => line.includes('文件 · 共 2 项')) && card.some(line => line.includes('src/cube.ts'))
  })
  return app.lines()
}

// Zero footprint: no host, and a host with no provider, render the file-only
// popup. The first render of a process also carries one-time terminal setup,
// so a warm-up boot runs first and the comparison is between two later boots.
const warmup = await boot()
await openAt(warmup)
warmup.instance.unmount()
const baseline = await boot()
const baselineLines = await openAt(baseline)
baseline.instance.unmount()
const baselineCard = cardRows(baselineLines)
check('file-only popup opens (baseline)', baselineCard.some(line => line.includes('文件 · 共 2 项')), baselineCard.join('\n'))

/** Line-level diff against the baseline screen ('' = identical). */
const diffFromBaseline = (lines: readonly string[]): string => lines
  .map((line, index) => (line === baselineLines[index] ? '' : `${index}: ${JSON.stringify(baselineLines[index])} → ${JSON.stringify(line)}`))
  .filter(Boolean)
  .join('\n')

const control = await boot()
const controlDiff = diffFromBaseline(await openAt(control))
control.instance.unmount()
check('control: two provider-less boots render the same screen', controlDiff === '', controlDiff)

const emptyHost = await boot({ size: () => 0, complete: async () => { throw new Error('must not be called') } })
const emptyDiff = diffFromBaseline(await openAt(emptyHost))
emptyHost.instance.unmount()
check('an empty provider host renders the baseline screen exactly', emptyDiff === '', emptyDiff)

// Provider rows beside files.
const signals: AbortSignal[] = []
const blender = {
  size: () => 1,
  complete: async (query: string, providerSignal: AbortSignal) => {
    signals.push(providerSignal)
    const items: ProvidedMentionCandidate[] = [
      { id: 'blender\u0000Cube', kind: 'provided', providerId: 'blender', section: 'Blender', label: 'Cube', detail: 'MESH', insertText: 'Cube（Blender 对象）' },
      { id: 'blender\u0000Camera', kind: 'provided', providerId: 'blender', section: 'Blender', label: 'Camera', detail: 'CAMERA', insertText: 'Camera（Blender 对象）' },
    ]
    return items.filter(item => item.label.toLowerCase().includes(query.toLowerCase()))
  },
}
const live = await boot(blender)
live.stdin.write('@')
await settled(() => cardRows(live.lines()).some(line => line.includes('Cube')))
live.stdin.write('c')
live.stdin.write('u')
await settle(() => cardRows(live.lines()).some(line => line.includes('提及')) && !cardRows(live.lines()).some(line => line.includes('Camera')))
const liveCard = cardRows(live.lines())
console.log(['', '  rendered popup (72 cols):', ...liveCard.map(line => `    ${line}`), ''].join('\n'))
check('popup title switches to 提及 once provider rows are present', liveCard.some(line => line.includes('提及 · 共')), liveCard[0])
check('provider row shows @ icon, label and "title · detail"', liveCard.some(line => /@ Cube\s+Blender · MESH/.test(line)), liveCard.join('\n'))
check('file rows still render beside provider rows', liveCard.some(line => line.includes('src/cube.ts')))
check('late provider rows do not steal the selection (kept by id, like files)', liveCard.some(line => line.includes('❯ + src/main.ts')), liveCard.join('\n'))
check('each new query aborts the previous provider call', signals.length >= 2 && signals.slice(0, -1).every(item => item.aborted) && signals.at(-1)?.aborted === false,
  JSON.stringify(signals.map(item => item.aborted)))
live.stdin.write('\x1b[A')
await settled(() => cardRows(live.lines()).some(line => line.includes('❯ @ Cube')))
check('↑ moves onto the provider row', cardRows(live.lines()).some(line => line.includes('❯ @ Cube')))
live.stdin.write('\r')
await settled(() => live.lines().some(line => line.includes('Cube（Blender 对象）')))
{
  // Read the prompt row with box-drawing residue folded to spaces: in a
  // process that already rendered once, this headless harness leaves the old
  // border's `─` cells under the input row after the popup closes (accepting
  // a FILE row on unmodified main shows the same), which is not what this
  // check is about.
  const lines = live.lines().map(line => (line.startsWith('❯') ? line.replace(/─/gu, ' ') : line))
  check('Enter inserts the plain insertText in place of @cu', lines.some(line => line.includes('Cube（Blender 对象）')) && !lines.some(line => line.includes('@cu')),
    lines.filter(line => line.trim() !== '').join('\n'))
}
live.stdin.write('\r')
await settled(() => live.channel.submitted.length > 0)
check('submit sends the inserted text verbatim', live.channel.submitted[0] === 'Cube（Blender 对象）', JSON.stringify(live.channel.submitted))
live.instance.unmount()

console.log(`\nverify:mention-providers ${failures === 0 ? 'OK' : 'FAILED'} (${checks} checks, ${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
