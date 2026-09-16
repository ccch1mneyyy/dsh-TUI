/**
 * 单行超长文本折叠回归（用户反馈：出现单行超长文本时默认不折叠，整行照
 * 渲染，拖慢转录；要求「一定长度下折叠」，默认开，涵盖 user 消息与工具
 * 调用命令等）。
 *
 * 机制：`src/utils/fold-long-lines.ts` 按行裁剪超长单行（每行 1000 字符
 * 预算，行尾内联 `… 已折叠 N 字符（ctrl+o 展开）` 标记），在文本进入布局
 * 引擎之前完成——wrap 的成本只看字符数，一行 20 万字符会铺成上千视觉行，
 * 每帧都在重复付这笔钱。Ctrl+O（全局展开）恢复原文。
 *
 * 断言：
 *  A. 纯函数单元：短文本零改动且保持引用（无分配快路径）、恰好等于预算
 *     不折、超 1 字符即折且字数准确、行边界不被改写、自定义预算生效。
 *  B. 转录渲染（真实 MessageList）：user 消息 / assistant 正文 / 工具卡
 *     （终端命令标题 + 终端输出）的超长单行都折叠——屏幕上出现折叠标记、
 *     行尾标记（1000 字符之后）不出现。
 *  C. Ctrl+O（expanded）是逃生门：同一行给出完整原文（行尾标记出现）。
 *  D. 工具卡独立渲染（AssistantToolUseMessage）：read 卡正文同样折叠，
 *     verbose 展开恢复；reasoning 行不折叠（自带三行预览，用户明确不做）。
 *
 * Run: `node --import tsx/esm scripts/verify-long-line-fold.tsx`
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'verify-long-line-fold-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir
// 折叠标记含本地化文案，钉住英文保证 CI（LANG=C）与本地一致。
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, Box, useInput, AlternateScreen },
  { MessageList },
  { AssistantToolUseMessage },
  { foldLongLines, LONG_LINE_MAX_CHARS },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/utils/fold-long-lines.js'),
  import('./lib/term-test.mjs'),
])

const { sleep, settled, findText } = termTest

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

const MARKER = 'chars folded (click or ctrl+o to expand)'
/** Head visible in every folded payload; the tail only survives unclipped. */
const HEAD = 'FOLDHEAD'
const TAIL = 'FOLDTAIL'

/** The marker is a long tail-of-line string, so a terminal row boundary can
 *  land inside it; comparisons run on whitespace-stripped text so a wrap (or
 *  a row-split marker) still matches, in both directions. */
const packed = (screen: string): string => screen.replace(/\s+/g, '')
const MARKER_PACKED = packed(MARKER)

/** Compact screen digest for failure messages. */
const digest = (screen: string): string => {
  const rows = screen.split('\n').filter(row => row.trim() !== '')
  return `${rows.length} rows, last=${JSON.stringify((rows.at(-1) ?? '').slice(-48))}`
}

/** The app only wires its stdin parser while some component subscribes
 *  (Chat always mounts PromptInput): mouse SGR bytes die silently without
 *  it, so the rig mirrors that condition. */
function KeySink(): React.ReactNode {
  useInput(() => {})
  return null
}

/** One pathological source line: recognizable head, ~60k filler, tail. */
function hugeLine(filler = 60_000): string {
  return `${HEAD}${'x'.repeat(filler)}${TAIL}`
}

// ---------------------------------------------------------------------------
// A — foldLongLines units
// ---------------------------------------------------------------------------
console.log('--- A: foldLongLines units ---')

{
  const source = 'plain question\nsecond line'
  const folded = foldLongLines(source)
  check('A1 short text is returned by identity (allocation-free fast path)',
    folded.text === source && folded.hiddenChars === 0 && folded.foldedLines === 0)
}

{
  const exact = 'a'.repeat(LONG_LINE_MAX_CHARS)
  const folded = foldLongLines(exact)
  check('A2 a line exactly at the budget is left alone',
    folded.text === exact && folded.foldedLines === 0)
  const over = 'a'.repeat(LONG_LINE_MAX_CHARS + 1)
  const one = foldLongLines(over)
  check('A3 one character over the budget folds exactly one character',
    one.foldedLines === 1 && one.hiddenChars === 1 && one.text.includes('1 chars folded'),
    one.text.slice(-60))
}

{
  const folded = foldLongLines('abcdef', 3)
  check('A4 custom budget clips and reports the marker inline',
    folded.text === `abc … 3 ${MARKER}`, JSON.stringify(folded.text))
}

{
  const source = ['first line', hugeLine(), 'last line'].join('\n')
  const folded = foldLongLines(source)
  const lines = folded.text.split('\n')
  check('A5 line boundaries survive the fold (markdown/diff line model)',
    lines.length === 3 && lines[0] === 'first line' && lines[2] === 'last line')
  check('A6 the folded line keeps its head and drops the tail',
    lines[1]!.startsWith(HEAD) && !lines[1]!.includes(TAIL) && lines[1]!.includes(MARKER),
    `len=${lines[1]!.length}`)
}

{
  const folded = foldLongLines([hugeLine(2_000), 'mid', hugeLine(3_000)].join('\n'))
  const expectedHidden = (hugeLine(2_000).length - LONG_LINE_MAX_CHARS) + (hugeLine(3_000).length - LONG_LINE_MAX_CHARS)
  check('A7 every over-long line folds and the hidden counts add up',
    folded.foldedLines === 2 && folded.hiddenChars === expectedHidden,
    `folded=${folded.foldedLines} hidden=${folded.hiddenChars} want=${expectedHidden}`)
  check('A8 empty input is a no-op', foldLongLines('').text === '')
}

{
  // The cut lands between the two UTF-16 code units of an astral char: the
  // fold must back off one unit rather than render half an emoji (U+FFFD).
  const emojiAtCut = `${'a'.repeat(LONG_LINE_MAX_CHARS - 1)}😀${'b'.repeat(200)}`
  const folded = foldLongLines(emojiAtCut)
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  check('A9 no surrogate pair is split at the cut',
    !loneSurrogate.test(folded.text) && folded.text.startsWith(`${'a'.repeat(LONG_LINE_MAX_CHARS - 1)} …`),
    JSON.stringify(folded.text.slice(-60)))
}

// ---------------------------------------------------------------------------
// B/C — MessageList integration (headless xterm)
// ---------------------------------------------------------------------------
const COLS = 120
const ROWS = 40

function makeRig(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  return { term, stdout: new FakeStdout(), stderr: new FakeStderr(), stdin: new FakeStdin() }
}

async function withMessageList(
  make: () => React.ReactElement,
  run: (rig: { screen: () => string; term: XTerm; stdin: PassThrough }) => Promise<void>,
): Promise<void> {
  const rig = makeRig(COLS, ROWS)
  const instance = await render(make(), {
    stdout: rig.stdout as unknown as NodeJS.WriteStream,
    stderr: rig.stderr as unknown as NodeJS.WriteStream,
    stdin: rig.stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const screen = (): string =>
    Array.from({ length: ROWS }, (_, y) => rig.term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  try {
    // 固定窗:pacing 等首帧——MessageList 首次布局无单一可观测锚点，且断言里
    // 有「裁掉的尾巴不得出现」这类否定式，轮询到某条件即返回等于没测。
    await sleep(200)
    await run({ screen, term: rig.term, stdin: rig.stdin })
  } finally {
    await instance.unmount()
    rig.term.dispose()
  }
}

/** SGR 左键 press + release（1 起坐标）→ 派发一次 click。 */
function click(stdin: PassThrough, col: number, row: number): void {
  stdin.write(`\x1b[<0;${col};${row}M`)
  stdin.write(`\x1b[<0;${col};${row}m`)
}

/** MessageList with the production row-expansion semantics wired up (Chat's
 *  toggleRowExpanded): the mouse toggle has to actually change state. */
function FoldList({ rows }: { rows: Row[] }): React.ReactElement {
  const [expandedRows, setExpandedRows] = React.useState<ReadonlySet<number>>(new Set<number>())
  return (
    <MessageList
      rows={rows}
      expanded={false}
      expandedRows={expandedRows}
      selectedId={null}
      onToggleRow={(rowId: number) => setExpandedRows((previous) => {
        const next = new Set(previous)
        if (next.has(rowId)) next.delete(rowId)
        else next.add(rowId)
        return next
      })}
      model="deepseek-chat"
      showAll
      onToggleAll={() => {}}
    />
  )
}

const listProps = {
  expanded: false,
  expandedRows: new Set<number>(),
  selectedId: null as number | null,
  onToggleRow: (_rowId: number): void => {},
  model: 'deepseek-chat',
  showAll: true,
  onToggleAll: (): void => {},
}

type Row = Parameters<typeof MessageList>[0]['rows'][number]

const hugeToolRow: Row = {
  id: 3,
  kind: 'tool',
  text: '',
  tool: {
    callId: 'fold-call',
    name: 'bash',
    argsText: '{}',
    argsFull: '{}',
    status: 'done',
    callView: { card: 'terminal', title: `${HEAD}-cmd-${'c'.repeat(60_000)}-${TAIL}` },
    resultView: { card: 'terminal', output: `${HEAD}-out-${'o'.repeat(60_000)}-${TAIL}`, exitCode: 0 },
    startedAt: Date.now() - 1_000,
    durationMs: 1_000,
  },
}

console.log('--- B: transcript rows fold by default ---')

{
  const rows: Row[] = [{ id: 1, kind: 'user', text: `${HEAD}-user-${'u'.repeat(60_000)}-${TAIL}` }]
  await withMessageList(
    () => <MessageList rows={rows} {...listProps} />,
    async ({ screen }) => {
      const text = screen()
      check('B1 user prompt: fold marker renders', packed(text).includes(MARKER_PACKED), digest(text))
      check('B2 user prompt: the clipped tail is gone',
        packed(text).includes(`${HEAD}-user-`) && !packed(text).includes(TAIL))
    },
  )
}

{
  const rows: Row[] = [{ id: 2, kind: 'assistant', text: `${HEAD}-text-${'a'.repeat(60_000)}-${TAIL}` }]
  await withMessageList(
    () => <MessageList rows={rows} {...listProps} />,
    async ({ screen }) => {
      const text = screen()
      check('B3 assistant body: fold marker renders', packed(text).includes(MARKER_PACKED), digest(text))
      check('B4 assistant body: the clipped tail is gone',
        packed(text).includes(`${HEAD}-text-`) && !packed(text).includes(TAIL))
    },
  )
}

{
  await withMessageList(
    () => <MessageList rows={[hugeToolRow]} {...listProps} />,
    async ({ screen }) => {
      const text = screen()
      check('B5 tool card title (one 60k-char command): fold marker renders',
        packed(text).includes(MARKER_PACKED), digest(text))
      check('B6 tool card title: the clipped tail is gone',
        packed(text).includes(`${HEAD}-cmd-`) && !packed(text).includes(TAIL))
      check('B7 tool card body (one 60k-char output line): the clipped tail is gone',
        packed(text).includes(`${HEAD}-out-`) && !packed(text).includes(TAIL))
    },
  )
}

console.log('--- C: Ctrl+O is the escape hatch ---')

{
  const rows: Row[] = [{ id: 1, kind: 'user', text: `${HEAD}-user-${'u'.repeat(60_000)}-${TAIL}` }]
  await withMessageList(
    () => <MessageList rows={rows} {...listProps} expanded />,
    async ({ screen }) => {
      const text = screen()
      check('C1 expanded user prompt paints the raw text', packed(text).includes(TAIL), digest(text))
      check('C2 expanded user prompt drops the fold marker', !packed(text).includes(MARKER_PACKED))
    },
  )
}

{
  await withMessageList(
    () => <MessageList rows={[hugeToolRow]} {...listProps} expanded />,
    async ({ screen }) => {
      const text = screen()
      check('C3 expanded tool card paints the raw command/output tail',
        packed(text).includes(TAIL), digest(text))
      check('C4 expanded tool card drops the fold marker', !packed(text).includes(MARKER_PACKED))
    },
  )
}

// ---------------------------------------------------------------------------
// E — mouse: click the folded row to expand, click again to collapse
// ---------------------------------------------------------------------------
console.log('--- E: mouse click toggles the fold ---')

{
  const rows: Row[] = [
    { id: 1, kind: 'user', text: `${HEAD}-user-${'u'.repeat(60_000)}-${TAIL}` },
    // notice 而不是 assistant：notice 行没有任何 expanded 相关装饰，展开态
    // 逐字节可比（assistant 展开会多一行 metadata，比较会被无关差异污染）。
    { id: 2, kind: 'notice', text: 'AFTER-ROW-MARKER' },
  ]
  let clickedScreen = ''
  await withMessageList(
    // 鼠标事件只在 alternate screen 激活时派发（Ink.dispatchClick 的闸门），
    // 所以这一组必须挂进 AlternateScreen——与真实全屏模式同构。
    () => <AlternateScreen><KeySink /><FoldList rows={rows} /></AlternateScreen>,
    async ({ screen, term, stdin }) => {
      check('E1 folded row shows the marker', packed(screen()).includes(MARKER_PACKED))
      check('E2 the row below the folded one renders', packed(screen()).includes('AFTER-ROW-MARKER'))
      const head = findText(term, `${HEAD}-user-`)
      check('E3 the folded row is on screen to click', head !== null, digest(screen()))
      if (head === null) return
      click(stdin, head.col + 1, head.row + 1)
      check('E4 a click on the folded row expands it',
        await settled(() => packed(screen()).includes(TAIL)), digest(screen()))
      check('E5 the expanded row drops the marker', !packed(screen()).includes(MARKER_PACKED))
      clickedScreen = packed(screen())
      const tail = findText(term, TAIL)
      // 独立断言：packed() 会吃掉换行，尾巴跨行时 E4 仍可能通过，而这里
      // findText 会返回 null —— 早退会让「收起失效」悄悄溜过 CI。
      check('E7 the expanded tail is on screen to click back', tail !== null, digest(screen()))
      if (tail === null) return
      click(stdin, tail.col + 1, tail.row + 1)
      check('E8 a second click collapses it back',
        await settled(() => packed(screen()).includes(MARKER_PACKED)), digest(screen()))
    },
  )
  // E6：同一批行用 Ctrl+O 展开的“冷渲染”必须与鼠标点开后画出的屏幕完全一致。
  // 行高缓存/签名若没跟着展开状态失效，点击路径会拿着折叠时的高度去排版
  // spacer 与窗口，两条路径就会画出不同的屏——这正是要守的不变量。
  await withMessageList(
    () => <AlternateScreen><KeySink /><MessageList rows={rows} {...listProps} expanded /></AlternateScreen>,
    async ({ screen }) => {
      check('E6 expanding by click paints exactly what Ctrl+O paints',
        packed(screen()) === clickedScreen && clickedScreen !== '', digest(screen()))
    },
  )
}

// 流式 assistant 行：折叠态同样要能点开（走的是独立的 streaming 分支，
// 状态与落定行分开，接线漏掉就会出现「显示折叠标记却点不动」）。
{
  const rows: Row[] = [{ id: 1, kind: 'assistant', text: `${HEAD}-stream-${'s'.repeat(60_000)}-${TAIL}`, streaming: true }]
  await withMessageList(
    () => <AlternateScreen><KeySink /><FoldList rows={rows} /></AlternateScreen>,
    async ({ screen, term, stdin }) => {
      check('E9 streaming row folds and shows the marker', packed(screen()).includes(MARKER_PACKED), digest(screen()))
      const head = findText(term, `${HEAD}-stream-`)
      check('E10 the streaming row is on screen to click', head !== null, digest(screen()))
      if (head === null) return
      click(stdin, head.col + 1, head.row + 1)
      check('E11 a click on the streaming row expands the arrived text',
        await settled(() => packed(screen()).includes(TAIL)), digest(screen()))
    },
  )
}

// ---------------------------------------------------------------------------
// D — component-level contracts
// ---------------------------------------------------------------------------
// The fold for transcript rows lives in MessageList (it owns `expanded` and
// the reveal slice); tool cards fold inside their own header/body, which is
// what these two mounts cover directly.
console.log('--- D: component contracts ---')

async function renderCard(verbose: boolean): Promise<string> {
  const rig = makeRig(COLS, ROWS)
  const instance = await render(
    <Box flexDirection="column">
      <AssistantToolUseMessage
        tool={{
          callId: 'read-call',
          name: 'read',
          argsText: '{}',
          argsFull: '{}',
          status: 'done',
          callView: { card: 'read', title: 'Read /tmp/huge.txt' },
          resultView: {
            card: 'read',
            title: 'Read /tmp/huge.txt',
            content: [{ type: 'text', text: `${HEAD}-read-${'r'.repeat(60_000)}-${TAIL}` }],
          },
          startedAt: Date.now() - 1_000,
          durationMs: 1_000,
        } as never}
        marginTopOnTurn={false}
        verbose={verbose}
      />
    </Box>,
    {
      stdout: rig.stdout as unknown as NodeJS.WriteStream,
      stderr: rig.stderr as unknown as NodeJS.WriteStream,
      stdin: rig.stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  // 固定窗:pacing 等首帧——同上：单卡挂载后直接读屏（含否定式断言）。
  await sleep(200)
  const text = Array.from({ length: ROWS }, (_, y) => rig.term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  await instance.unmount()
  rig.term.dispose()
  return text
}

{
  const folded = await renderCard(false)
  check('D2 read card body folds its over-long line',
    packed(folded).includes(MARKER_PACKED) && !packed(folded).includes(TAIL), digest(folded))
  const verbose = await renderCard(true)
  check('D3 verbose read card paints the raw line',
    packed(verbose).includes(TAIL) && !packed(verbose).includes(MARKER_PACKED), digest(verbose))
}

console.log('')
if (failed > 0) {
  console.error(`verify-long-line-fold: ${failed} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-long-line-fold: all checks passed')
