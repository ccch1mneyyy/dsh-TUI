/**
 * Divider measurement-loop regression (React error #185 — maximum update
 * depth exceeded, crash on spawn): the rendered rule width feeds back into
 * the width Yoga grants the Box, so in a content-sized context (children
 * of a row parent keep their content width) a `padding` makes every
 * applied measurement shorten the rule by `padding` again — the
 * measure/setState-per-commit chain never converges and the reconciler
 * aborts after 50 nested updates, killing the whole TUI process.
 *
 * Asserts the negotiation is bounded: the converging case still measures
 * exactly once, a drifting layout freezes after a few corrections instead
 * of looping forever, and a resize reopens the negotiation rather than
 * staying frozen at the pre-resize width.
 * Run: node --import tsx/esm scripts/verify-divider-stability.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, ui, { Divider }, { settled, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/design-system/Divider.js'),
    import('./lib/term-test.mjs'),
  ])
const { render, ThemeProvider, Box, Text } = ui

const COLS = 60
const ROWS = 8
// Corrections the guard may apply per terminal-width generation before
// freezing; the drifting scenario would otherwise shorten the rule once
// per commit all the way to zero columns.
const MEASUREMENT_LIMIT = 8

// Hard watchdog: a regression here historically manifests as a render
// crash or a wedged reconciler, so never leave CI hanging on open handles.
const watchdog = setTimeout(() => {
  console.error('FAIL: verify-divider-stability timed out')
  process.exit(1)
}, 20000)

function makeStdout(term, columns = COLS) {
  class FakeStdout extends Writable {
    constructor() { super(); this.columns = columns; this.rows = ROWS; this.isTTY = true }
    _write(chunk, _encoding, callback) { term.write(String(chunk), callback) }
  }
  return new FakeStdout()
}

// Divider under test in a content-sized context: the Divider's Box is a
// child of a row parent, so Yoga grants it exactly its content width —
// the feedback loop under test. The marker sits on its own row below.
async function mountDivider(padding, columns = COLS) {
  const term = new XTerm({ cols: columns, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = makeStdout(term, columns)
  const app = await render(
    <ThemeProvider theme="dark">
      <Box flexDirection="column" width="100%">
        <Box flexDirection="row">
          <Divider padding={padding} />
        </Box>
        <Box><Text>marker-row</Text></Box>
      </Box>
    </ThemeProvider>,
    { stdout, exitOnCtrlC: false, patchConsole: false },
  )
  return { term, stdout, app }
}

function ruleRow(lines) {
  return lines.filter(l => l.includes('─'))
}

function assertSingleRule(lines, label) {
  const rules = ruleRow(lines)
  if (rules.length !== 1) {
    throw new Error(label + ': expected exactly one rule row, got ' + rules.length + ':\n' + lines.join('\n'))
  }
  return [...rules[0]].length
}

// 1. Converging case (padding 0): one measurement, full-width stable rule.
//    Also proves the context is content-sized, which scenario 2 relies on.
{
  const { term, app } = await mountDivider(0)
  const ok = await settled(() => viewportLines(term, ROWS).some(l => l.includes('marker-row')))
  if (!ok) throw new Error('marker row never rendered (padding 0)')
  const width = assertSingleRule(viewportLines(term, ROWS), 'padding-0 rule')
  if (width !== COLS) {
    throw new Error('padding-0 rule width ' + width + ' != terminal ' + COLS)
  }
  await app.unmount()
}

// 2. Drifting layout (padding 1 in a content-sized context): without the
//    guard every applied measurement shortens the rule by 1 again, the
//    loop trips React's max-update-depth (#185) and the render crashes;
//    with it, the negotiation freezes after at most MEASUREMENT_LIMIT
//    corrections and the rule stays a stable single row.
{
  const { term, app } = await mountDivider(1)
  const ok = await settled(() => viewportLines(term, ROWS).some(l => l.includes('marker-row')))
  if (!ok) throw new Error('marker row never rendered (padding 1 — render crashed?)')
  const width = assertSingleRule(viewportLines(term, ROWS), 'padding-1 rule')
  const floor = COLS - 1 - MEASUREMENT_LIMIT
  if (width < floor || width > COLS - 1) {
    throw new Error(
      'padding-1 rule width ' + width + ' outside bounded range [' + floor + ', ' + (COLS - 1) + '] — measurement loop not frozen:\n'
      + viewportLines(term, ROWS).join('\n'),
    )
  }
  await app.unmount()
}

// 3. Resize reopens the negotiation: after shrinking the terminal the
//    rule re-measures into the new width (bounded again) instead of
//    staying frozen at the pre-resize width.
{
  const { term, stdout, app } = await mountDivider(1)
  if (!await settled(() => viewportLines(term, ROWS).some(l => l.includes('marker-row')))) {
    throw new Error('marker row never rendered (resize scenario)')
  }
  stdout.columns = 40
  stdout.emit('resize')
  const shrunk = await settled(() =>
    viewportLines(term, ROWS).some(l => l.includes('marker-row')) && ruleRow(viewportLines(term, ROWS)).every(r => [...r].length <= 40),
  )
  if (!shrunk) {
    throw new Error('rule never shrank after resize:\n' + viewportLines(term, ROWS).join('\n'))
  }
  const width = assertSingleRule(viewportLines(term, ROWS), 'post-resize rule')
  const floor = 40 - 1 - MEASUREMENT_LIMIT
  if (width < floor || width > 40 - 1) {
    throw new Error(
      'post-resize rule width ' + width + ' outside bounded range [' + floor + ', ' + (40 - 1) + ']:\n'
      + viewportLines(term, ROWS).join('\n'),
    )
  }
  await app.unmount()
}

// 4. Growth resize also re-seeds from the new terminal width. Keeping the
//    old measuredWidth here would render the Box at its pre-resize width,
//    measure that same stale width again, and leave the rule permanently
//    narrow even though the terminal grew.
{
  const initialColumns = 40
  const expandedColumns = 60
  const { term, stdout, app } = await mountDivider(1, initialColumns)
  if (!await settled(() => viewportLines(term, ROWS).some(l => l.includes('marker-row')))) {
    throw new Error('marker row never rendered (growth-resize scenario)')
  }
  const before = assertSingleRule(viewportLines(term, ROWS), 'pre-growth rule')
  term.resize(expandedColumns, ROWS)
  stdout.columns = expandedColumns
  stdout.emit('resize')
  const grown = await settled(() =>
    ruleRow(viewportLines(term, ROWS)).some(r => [...r].length > before),
  )
  if (!grown) {
    throw new Error('rule never grew after resize:\n' + viewportLines(term, ROWS).join('\n'))
  }
  const width = assertSingleRule(viewportLines(term, ROWS), 'post-growth rule')
  const floor = expandedColumns - 1 - MEASUREMENT_LIMIT
  if (width < floor || width > expandedColumns - 1) {
    throw new Error(
      'post-growth rule width ' + width + ' outside bounded range [' + floor + ', ' + (expandedColumns - 1) + ']:\n'
      + viewportLines(term, ROWS).join('\n'),
    )
  }
  await app.unmount()
}

clearTimeout(watchdog)
console.log('OK: Divider measurement negotiation is bounded (no #185 update loop, resize reopens).')
process.exit(0)
