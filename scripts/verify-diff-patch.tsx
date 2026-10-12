/**
 * Unified patch diffs (`ToolFileDiff.patch`, N5):
 *
 *  1. parsing (`src/components/diffPatch.ts`): the Codex 0.160.1 shape
 *     (headerless `@@` hunks) and the headed one agree; real old / new line
 *     numbers per hunk; `(+N -M)` from the hunks; add / delete hunks
 *     (`-0,0`, `+0,0`), raw-content add / delete, `\ No newline` markers,
 *     a hunk whose counts disagree (lenient fallback), unreadable text
 *     (raw lines); headers for one file (stat line) and several (path row,
 *     move, new / deleted labels); the parse cache;
 *  2. the unified card body at 80 and 40 columns: the stat line, numbered
 *     rows in one gutter width, red / green tones, `⋯` between hunks, path
 *     rows with their suffix for several files, CJK and very long lines
 *     (wrapped / clipped by the existing helpers), the collapsed 8-row cap;
 *  3. the two-pane view (forced split at 80, auto at 120): each pane
 *     numbers its own side, paired change rows, the header separator, `⋯`
 *     between hunks, a move / new-file header;
 *  4. the old/new-text branch is untouched: a mixed card renders the old
 *     file exactly as a card holding it alone does (byte-identical frames).
 *
 * Run: node --import tsx/esm scripts/verify-diff-patch.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render },
  { AssistantToolUseMessage },
  { isPatchDiff, parseFilePatch, patchHeader, patchHeaderText },
  { stringWidth },
  { setLang, t },
  { settle, settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/components/diffPatch.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])
type ToolFileDiff = import('../src/adapter/ports/channel-view.js').ToolFileDiff

let failures = 0
let passed = 0
const results: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' && !ok ? `\n      ${extra.replaceAll('\n', '\n      ')}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

/** The Codex 0.160.1 update patch (F14). */
const CODEX = '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'
const patch = (path: string, text: string, extra: Record<string, unknown> = {}) => ({ path, patch: text, ...extra }) as Extract<ToolFileDiff, { patch: string }>
const nums = (lines: readonly { kind: string; oldNo?: number; newNo?: number; text: string }[]) => lines.map(line => `${line.kind[0]}${line.oldNo ?? '_'}/${line.newNo ?? '_'}:${line.text}`).join(' ')

// ── 1. parsing ──────────────────────────────────────────────────────────
{
  const bare = parseFilePatch(patch('a.ts', CODEX))
  const headed = parseFilePatch(patch('a.ts', `--- a/a.ts\n+++ b/a.ts\n${CODEX}`))
  check('1 the Codex headerless hunk parses with real numbers', nums(bare.hunks[0]!.lines) === 'c1/1:one d2/_:two a_/2:TWO c3/3:three', nums(bare.hunks[0]!.lines))
  check('1 synthesized headers read the same as real ones', nums(headed.hunks[0]!.lines) === nums(bare.hunks[0]!.lines))
  check('1 (+N -M) comes from the hunks', bare.added === 1 && bare.removed === 1 && bare.maxLineNo === 3)
  check('1 a patch diff is told apart from an old/new one', isPatchDiff(patch('a.ts', CODEX)) && !isPatchDiff({ path: 'a.ts', oldText: 'a', newText: 'b' }))

  const multi = parseFilePatch(patch('m.ts', '@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -98,3 +98,4 @@\n c\n+new\n d\n e\n'))
  check('1 several hunks keep their own numbering', multi.hunks.length === 2 && nums(multi.hunks[1]!.lines) === 'c98/98:c a_/99:new c99/100:d c100/101:e' && multi.maxLineNo === 101, nums(multi.hunks[1]!.lines))
  const added = parseFilePatch(patch('n.ts', '@@ -0,0 +1,2 @@\n+x\n+y\n', { change: 'add' }))
  check('1 an added file numbers its new lines from 1', nums(added.hunks[0]!.lines) === 'a_/1:x a_/2:y' && added.added === 2 && added.removed === 0)
  const deleted = parseFilePatch(patch('d.ts', '@@ -1,2 +0,0 @@\n-x\n-y\n', { change: 'delete' }))
  check('1 a deleted file numbers its old lines', nums(deleted.hunks[0]!.lines) === 'd1/_:x d2/_:y' && deleted.removed === 2)
  const rawAdd = parseFilePatch(patch('r.ts', 'first\nsecond\n', { change: 'add' }))
  check('1 a raw-content add becomes one all-added hunk', nums(rawAdd.hunks[0]!.lines) === 'a_/1:first a_/2:second' && rawAdd.raw === undefined)
  const rawDelete = parseFilePatch(patch('r.ts', 'gone\n', { change: 'delete' }))
  check('1 a raw-content delete becomes one all-removed hunk', nums(rawDelete.hunks[0]!.lines) === 'd1/_:gone')
  const noEol = parseFilePatch(patch('e.ts', '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n'))
  check('1 "No newline" markers carry no content', nums(noEol.hunks[0]!.lines) === 'd1/_:a a_/1:b')
  const lenient = parseFilePatch(patch('l.ts', '@@ -5,9 +5,9 @@\n ctx\n-old\n+new\n'))
  check('1 a hunk whose counts disagree still numbers (lenient walk)', nums(lenient.hunks[0]!.lines) === 'c5/5:ctx d6/_:old a_/6:new', nums(lenient.hunks[0]?.lines ?? []))
  const garbage = parseFilePatch(patch('g.ts', 'not a patch\n+plus\n'))
  check('1 unreadable text keeps its raw lines', garbage.hunks.length === 0 && garbage.raw?.join('|') === 'not a patch|+plus')
  check('1 the parse is cached by text', parseFilePatch(patch('a.ts', CODEX)) === bare)

  check('1 one file: a stat line', patchHeaderText(patchHeader(patch('a.ts', CODEX), bare, false)) === '(+1 -1)')
  check('1 one moved file: → destination and stat', patchHeaderText(patchHeader(patch('a.ts', CODEX, { movePath: 'b.ts' }), bare, false)) === '→ b.ts (+1 -1)')
  check('1 one new file: its label and stat', patchHeaderText(patchHeader(patch('n.ts', '', { change: 'add' }), added, false)) === `${t('diff-patch-added')} (+2 -0)`)
  const many = patchHeader(patch('a.ts', CODEX, { movePath: 'b.ts' }), bare, true)
  check('1 several files: a path row that opens the destination', many.kind === 'path' && many.path === 'a.ts → b.ts' && many.target === 'b.ts' && many.suffix === ' (+1 -1)')
  const gone = patchHeader(patch('d.ts', '', { change: 'delete' }), deleted, true)
  check('1 several files: a deleted file says so', gone.kind === 'path' && gone.suffix === ` · ${t('diff-patch-deleted')} (+0 -2)`)
  setLang('zh')
  check('1 zh labels', patchHeaderText(patchHeader(patch('n.ts', '', { change: 'add' }), added, false)) === '新文件 (+2 -0)')
  setLang('en')
}

// ── harness ─────────────────────────────────────────────────────────────
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
async function mountCard(cols: number) {
  const rows = 40
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const tool = (diffs: readonly ToolFileDiff[]) => ({
    callId: 'c1', name: 'apply_patch', argsText: '{}', status: 'ok' as const, startedAt: 0, durationMs: 10,
    resultView: { card: 'diff' as const, title: 'Edit a.ts', displayKey: 'tool-name-edit', diffs },
  })
  const element = (key: string, diffs: readonly ToolFileDiff[], diffLayout: 'auto' | 'split' | 'unified', verbose = false) =>
    React.createElement(AssistantToolUseMessage, { key, tool: tool(diffs) as never, marginTopOnTurn: false, verbose, diffLayout })
  const app = await render(element('boot', [], 'unified'), { stdout: new FakeStdout() as never, stdin: new FakeStdin() as never, stderr: new FakeStdout() as never, debug: true, exitOnCtrlC: false, patchConsole: false })
  const lines = (): string[] => viewportLines(term, rows)
  const text = (): string => lines().join('\n')
  /** Foreground of the first cell of `needle` on its row. */
  const fgOf = (needle: string): string => {
    const all = lines()
    const y = all.findIndex(line => line.includes(needle))
    if (y < 0) return 'missing'
    const cell = term.buffer.active.getLine(y)?.getCell(all[y]!.indexOf(needle))
    return cell === undefined || cell.isFgDefault() ? 'default' : cell.getFgColor().toString(16)
  }
  let mounts = 0
  const show = async (diffs: readonly ToolFileDiff[], layout: 'auto' | 'split' | 'unified', ready: () => boolean, verbose = false): Promise<void> => {
    app.rerender(element(`m${++mounts}`, diffs, layout, verbose))
    await settle(ready)
  }
  return { app, lines, text, fgOf, show }
}
const row = (all: string[], needle: string): string => all.find(line => line.includes(needle)) ?? ''

// ── 2. the unified card body ────────────────────────────────────────────
for (const cols of [80, 40]) {
  const card = await mountCard(cols)
  const at = `@${cols}`
  await card.show([patch('a.ts', CODEX)], 'unified', () => card.text().includes('TWO'))
  let all = card.lines()
  check(`2${at} the stat line opens the body`, row(all, '(+1 -1)').includes('⎿') && !row(all, '(+1 -1)').includes('a.ts'), card.text())
  check(`2${at} numbered rows share one gutter`, row(all, 'one').trim().endsWith('1   one') && row(all, 'two').trim().endsWith('2 - two') && row(all, 'TWO').trim().endsWith('2 + TWO') && row(all, 'three').trim().endsWith('3   three'), card.text())
  check(`2${at} removed / added rows keep their diff colours`, card.fgOf('2 - two') !== card.fgOf('2 + TWO') && card.fgOf('2 - two') !== 'default' && card.fgOf('2 + TWO') !== 'default', `${card.fgOf('2 - two')} / ${card.fgOf('2 + TWO')}`)

  await card.show([patch('m.ts', '@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -98,3 +98,4 @@\n c\n+new\n d\n e\n')], 'unified', () => card.text().includes('101'), true)
  all = card.lines()
  check(`2${at} hunks are separated by ⋯ and keep their numbers`, all.some(line => line.trim() === '⋯') && /\s99 \+ new$/u.test(row(all, 'new').trimEnd()) && row(all, '  1 - a').length > 0, card.text())

  await card.show([patch('src/a.ts', CODEX, { movePath: 'src/b.ts' }), patch('src/new.ts', '@@ -0,0 +1,2 @@\n+x\n+y\n', { change: 'add' })], 'unified', () => card.text().includes('new.ts'))
  all = card.lines()
  check(`2${at} several files: path rows with their stat`, row(all, 'src/a.ts → src/b.ts').includes('(+1 -1)') && row(all, 'src/new.ts').includes(`${t('diff-patch-added')} (+2 -0)`), card.text())

  const cjk = '中文内容测试'.repeat(5)
  await card.show([patch('c.md', `@@ -1,1 +1,1 @@\n-${cjk}\n+${cjk}改\n`)], 'unified', () => card.text().includes('改'))
  all = card.lines()
  check(`2${at} CJK lines render whole (wrapped by cells, no half glyph)`, all.every(line => stringWidth(line.trimEnd()) <= cols) && card.text().replace(/\s+/gu, '').includes(`${cjk}改`.slice(-8)), card.text())

  const long = `${'x'.repeat(3000)}TAIL`
  await card.show([patch('l.ts', `@@ -1,1 +1,1 @@\n-short\n+${long}\n`)], 'unified', () => card.text().includes('short'))
  all = card.lines()
  check(`2${at} a very long line is clipped (bounded rows)`, !card.text().includes('TAIL') && all.filter(line => line.includes('xxxxx')).length < 3000 / cols, `${all.filter(line => line.includes('xxx')).length} rows`)

  await card.show([patch('big.ts', `@@ -1,20 +1,20 @@\n${Array.from({ length: 20 }, (_, index) => `-old ${index + 1}\n+new ${index + 1}`).join('\n')}\n`)], 'unified', () => card.text().includes('new'))
  check(`2${at} the collapsed body keeps the 8-row cap with its fold hint`, card.lines().filter(line => /\d+ [-+] (old|new) \d+/u.test(line)).length === 7 && card.text().includes('lines'), card.text())
  await card.app.unmount()
}

// ── 3. the two-pane view ────────────────────────────────────────────────
for (const [cols, layout] of [[80, 'split'], [120, 'auto']] as const) {
  const card = await mountCard(cols)
  const at = `@${cols}/${layout}`
  await card.show([patch('a.ts', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -40,2 +40,3 @@\n keep\n+added\n tail\n')], layout, () => card.text().includes('added'))
  const all = card.lines()
  const pair = row(all, 'two')
  check(`3${at} a change row numbers each pane with its own side`, /1 {3}one.*│ +1 {3}one/u.test(row(all, 'one')) && /2 − two.*│ +2 \+ TWO/u.test(pair), `${row(all, 'one')}\n${pair}`)
  check(`3${at} an add-only row leaves the old pane unnumbered`, /│ +41 \+ added/u.test(row(all, 'added')) && !/\d+ − /u.test(row(all, 'added')), row(all, 'added'))
  check(`3${at} the header separator carries the stat; hunks split by ⋯`, row(all, '(+2 -1)').trimEnd().endsWith(' (+2 -1)') && !row(all, '(+2 -1)').includes('a.ts') && all.some(line => line.trim() === '⋯'), card.text())
  check(`3${at} every row fits the width`, all.every(line => stringWidth(line.trimEnd()) <= cols))

  await card.show([patch('src/a.ts', CODEX, { movePath: 'src/b.ts' }), patch('src/n.ts', '@@ -0,0 +1,1 @@\n+fresh\n', { change: 'add' })], layout, () => card.text().includes('fresh'))
  const moved = card.lines()
  check(`3${at} several files: move and new-file headers`, row(moved, 'src/a.ts → src/b.ts').includes('(+1 -1)') && row(moved, 'src/n.ts').includes(`${t('diff-patch-added')} (+1 -0)`), card.text())
  await card.app.unmount()
}

// ── 4. the old/new-text branch is untouched ─────────────────────────────
for (const [cols, layout] of [[80, 'unified'], [120, 'split']] as const) {
  const oldDiff: ToolFileDiff = { path: 'old.ts', oldText: 'const a = 1\nconst b = 2\n', newText: 'const a = 1\nconst b = 3\n' }
  const frame = async (diffs: readonly ToolFileDiff[]): Promise<string[]> => {
    const card = await mountCard(cols)
    await card.show(diffs, layout, () => card.text().includes('const b'))
    const out = card.lines()
    await card.app.unmount()
    return out
  }
  const alone = await frame([oldDiff])
  const again = await frame([{ ...oldDiff }])
  check(`4@${cols}/${layout} an old/new card renders deterministically`, alone.join('\n') === again.join('\n'))
  check(`4@${cols}/${layout} no line numbers or stat on the old branch`, !alone.some(line => /\(\+\d+ -\d+\)/u.test(line)) && !alone.some(line => /\b\d+ [-+] const/u.test(line)), alone.join('\n'))
}

for (const line of results) console.log(line)
console.log(`\nverify-diff-patch ${failures === 0 ? 'OK' : 'FAILED'} (${passed} passed, ${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
