#!/usr/bin/env node
/**
 * Layout regression for the session browser, across terminal geometries and
 * BOTH interface languages.
 *
 * The oracle is the emulator's own wrap flag. A terminal marks a line as
 * wrapped when the previous one overflowed its width, so "no line in the
 * frame is a continuation" is a precise, theory-free statement that nothing
 * the browser drew was wider than the screen. That matters more than it
 * sounds: this screen lays its header out by measuring text and padding to a
 * computed gap, and a single over-wide row does not merely look wrong — it
 * pushes every region below it down a line and shoves the hint row off the
 * bottom.
 *
 * Running both languages is the point of the file. Every string here is
 * localized and the default language is Chinese, where a character is two
 * columns wide; a layout measured in characters passes in English and wraps
 * in Chinese. An English-only test cannot see that class of bug at all.
 *
 * Run: `node scripts/verify-session-browser-layout.mjs`
 * Exits 1 on any failed assertion (CI gate).
 */
import { Writable, PassThrough } from 'node:stream'
import xtermPkg from '@xterm/headless'
import React from 'react'
import { render, ThemeProvider } from '../lib/types/ui.js'
import { SessionBrowser } from '../lib/types/screens/SessionBrowser.js'
import { setLang } from '../lib/types/i18n.js'

const { Terminal } = xtermPkg

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const summary = (over) => ({
  id: 'id',
  kind: { kind: 'root' },
  title: { text: 'title', source: 'auto' },
  cwd: '/tmp/project',
  createdAt: 1,
  updatedAt: 1,
  bytes: 2048,
  hasPrompt: true,
  agentPreset: 'standard',
  model: 'deepseek-v4-pro',
  label: undefined,
  branch: 'feat/trajectory',
  childCount: 0,
  ...over,
})

/**
 * Sessions chosen to stress the parts that measure text: CJK titles, a mix
 * of kinds so the header's counts are long, and a wide branch name.
 */
const SESSIONS = [
  summary({ id: 's1', title: { text: '深度思考，全面分析当前实现的每一处细节并给出结论', source: 'auto' }, updatedAt: 9 }),
  summary({ id: 's2', title: { text: 'a fairly long english session title that keeps going', source: 'renamed' }, updatedAt: 8 }),
  summary({ id: 's3', title: { text: '恢复会话', source: 'prompt' }, updatedAt: 7 }),
  summary({ id: 's4', title: { text: 'tmp', source: 'fallback' }, updatedAt: 6, cwd: '/tmp/other' }),
  summary({ id: 'r1', title: { text: '你是终稿评审助理。任务：对多份终稿做逐行一致性审计', source: 'prompt' }, updatedAt: 5, label: '一致性审计', kind: { kind: 'subagent', parent: 's1', depth: 1 } }),
  summary({ id: 'r2', title: { text: 'delegated run two', source: 'prompt' }, updatedAt: 4, kind: { kind: 'subagent', parent: 's1', depth: 1 } }),
  summary({ id: 'f1', title: { text: '回溯分支', source: 'auto' }, updatedAt: 3, kind: { kind: 'fork', parent: 's1' } }),
  summary({ id: 'e1', title: { text: 'project', source: 'fallback' }, updatedAt: 2, hasPrompt: false }),
]

function makeChannel() {
  return {
    cwd: '/tmp/project',
    gitBranch: 'feat/trajectory',
    agentId: 'live',
    listSessions: async () => SESSIONS.map(s => ({ ...s })),
    previewSession: async () => [
      { role: 'user', text: '深度思考，全面分析当前实现的每一处细节，并给出可以逐条验证的结论与最小复现路径。', at: 1 },
      { role: 'assistant', text: 'A reply long enough to need wrapping inside the preview pane at every width this sweep visits.', at: 2 },
    ],
    notify() {},
    resumeTo: async () => true,
    deleteSession: async () => true,
    renameSessionTo: async () => true,
  }
}

const sameProject = (a, b) => a === b

function makeStreams(cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: 50, allowProposedApi: true })
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      term.write(String(chunk))
      cb()
    },
  })
  stdout.term = term
  stdout.columns = cols
  stdout.rows = rows
  stdout.isTTY = true
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin, term }
}

/** Every line of the visible frame, plus whether the terminal had to wrap it. */
function frame(term) {
  const buffer = term.buffer.active
  const lines = []
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(y)
    if (line === undefined) continue
    lines.push({ text: line.translateToString(true).replace(/\s+$/, ''), wrapped: line.isWrapped === true })
  }
  return lines
}

// Widths span the two-column split threshold (100) and the narrow tiers;
// heights span "comfortable" down to "barely enough for the chrome".
// 6 rows is the floor by construction: the chrome is six lines, so that is
// the shortest terminal where every region still has somewhere to be.
const SIZES = [[180, 44], [120, 30], [110, 34], [99, 24], [80, 20], [60, 14], [46, 10], [40, 8], [52, 6]]
const KEYS = [
  ['\t', 'preview on'],
  ['\x13', 'runs revealed'],
  ['\x01', 'all projects'],
  ['\x12', 'rename editor'],
  ['\x1b', 'rename cancelled'],
  ['\x04', 'delete confirmation'],
  ['\x1b', 'confirmation cancelled'],
  ['深度', 'CJK query'],
]

for (const lang of ['zh', 'en']) {
  setLang(lang)
  for (const [cols, rows] of SIZES) {
    const { stdout, stderr, stdin, term } = makeStreams(cols, rows)
    const instance = await render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(SessionBrowser, {
          channel: makeChannel(),
          home: '/home/tester',
          sameProject,
          onClose: () => {},
        }),
      ),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(620)

    const inspect = (label) => {
      const lines = frame(term)
      const wrapped = lines.filter(l => l.wrapped)
      check(
        `${lang} ${cols}x${rows} ${label}: nothing overflows the width`,
        wrapped.length === 0,
        wrapped.length === 0 ? '' : `${wrapped.length} wrapped, first=${JSON.stringify(wrapped[0]?.text.slice(0, 60))}`,
      )
      // The hint row is the LAST region drawn, so requiring it to be the last
      // non-empty line on screen is the whole layout stated as one assertion:
      // every region above it fitted, nothing wrapped into extra rows, and
      // nothing was pushed off the bottom. `Esc` is its final key, so its
      // presence also proves the row itself was not cut short.
      const body = lines.map(l => l.text).filter(text => text.length > 0)
      const last = body[body.length - 1] ?? ''
      check(
        `${lang} ${cols}x${rows} ${label}: the hint row is the last line, intact`,
        /Esc/.test(last),
        /Esc/.test(last) ? '' : JSON.stringify(body.slice(-3)),
      )
    }

    inspect('initial')
    for (const [keys, label] of KEYS) {
      stdin.write(keys)
      await sleep(150)
      inspect(label)
    }

    // Maximizing the window mid-browse is an ordinary thing to do, and every
    // measurement above is taken against a width the component re-reads each
    // render — so the layout has to hold at the NEW size without remounting.
    const wide = [Math.min(200, cols + 60), Math.min(50, rows + 12)]
    term.resize(wide[0], wide[1])
    stdout.columns = wide[0]
    stdout.rows = wide[1]
    stdout.emit('resize')
    await sleep(260)
    inspect(`resized to ${wide[0]}x${wide[1]}`)

    instance.unmount()
    term.dispose()
    await sleep(20)
  }
}

setLang('zh')

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall session-browser layout checks passed')
