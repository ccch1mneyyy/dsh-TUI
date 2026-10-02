import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-tui-history-search-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

try {
  const { appendHistory, historyEntryId, loadHistory } = await import('../src/history.ts')
  const workspace = fileURLToPath(new URL('..', import.meta.url))

  const duplicateA = { text: '你好', ts: 1 }
  const duplicateB = { text: '你好', ts: 2 }
  assert.notEqual(
    historyEntryId(duplicateA, 0),
    historyEntryId(duplicateB, 1),
    'duplicate history text needs distinct React keys',
  )

  await appendHistory('你好')
  await appendHistory('知道')
  await appendHistory('你好')
  assert.deepEqual(
    loadHistory().map(entry => entry.text),
    ['你好', '知道', '你好'],
    'non-consecutive duplicate history entries should remain searchable',
  )

  for (let index = 0; index < 250; index += 1) {
    await appendHistory(`cmd ${index}`)
  }
  const capped = loadHistory()
  assert.equal(capped.length, 200, 'persisted history stays capped')
  assert.equal(capped[0]?.text, 'cmd 249')
  assert.equal(capped.at(-1)?.text, 'cmd 50')

  // Project scoping: each workspace walks its own entries plus the legacy
  // (unscoped) ones; another project's inputs never leak in, and the
  // per-project cap does not evict a different project's entries.
  const projectA = join(fakeHome, 'repo-a')
  const projectB = join(fakeHome, 'repo-b')
  await appendHistory('only in a', projectA)
  await appendHistory('only in b', projectB)
  await appendHistory('only in a', `${projectA}/`)
  const viewA = loadHistory(projectA).map(entry => entry.text)
  const viewB = loadHistory(projectB).map(entry => entry.text)
  assert.equal(viewA[0], 'only in a', 'project A sees its newest entry first')
  assert.equal(viewA.filter(text => text === 'only in a').length, 1, 'same-project consecutive duplicate dedupes across an interleaved project')
  assert.equal(viewA.includes('only in b'), false, 'project A never sees project B entries')
  assert.equal(viewB[0], 'only in b', 'project B sees its own entry')
  assert.equal(viewB.includes('only in a'), false, 'project B never sees project A entries')
  assert.equal(viewB.includes('cmd 249'), true, 'legacy unscoped entries stay visible per project')
  for (let index = 0; index < 250; index += 1) {
    await appendHistory(`a cmd ${index}`, projectA)
  }
  const cappedA = loadHistory(projectA)
  assert.equal(cappedA.length, 200, 'per-project view stays capped')
  assert.equal(cappedA[0]?.text, 'a cmd 249')
  assert.equal(cappedA.at(-1)?.text, 'a cmd 50', 'own entries push legacy ones out of the view')
  assert.equal(loadHistory(projectB)[0]?.text, 'only in b', 'another project survives the per-project cap')

  // A project's first submit that repeats the newest legacy entry its view
  // already shows dedupes against it instead of doubling the walk's head.
  const projectC = join(fakeHome, 'repo-c')
  await appendHistory('cmd 249', projectC)
  const viewC = loadHistory(projectC).map(entry => entry.text)
  assert.equal(viewC[0], 'cmd 249', 'project C still heads its view with the repeated input')
  assert.notEqual(viewC[1], 'cmd 249', 'a repeat of the newest legacy entry does not duplicate it')
  await appendHistory('only in c', projectC)
  assert.equal(loadHistory(projectC)[0]?.text, 'only in c', 'a new input still lands after the legacy dedup')

  const staleLock = join(fakeHome, '.dsh-tui', 'history.jsonl.lock')
  mkdirSync(staleLock, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  utimesSync(staleLock, old, old)
  await appendHistory('after stale lock')
  assert.equal(existsSync(staleLock), false, 'stale history lock is removed')
  assert.equal(loadHistory()[0]?.text, 'after stale lock', 'append recovers after stale lock')

  const liveLock = join(fakeHome, '.dsh-tui', 'history.jsonl.lock')
  mkdirSync(liveLock)
  let eventLoopResponsive = false
  const releaseLiveLock = setTimeout(() => {
    eventLoopResponsive = true
    rmSync(liveLock, { recursive: true, force: true })
  }, 25)
  try {
    const started = performance.now()
    const pendingAppend = appendHistory('after live lock')
    assert.ok(
      performance.now() - started < 50,
      'a live history lock must not block the caller before channel dispatch',
    )
    await pendingAppend
    assert.equal(eventLoopResponsive, true, 'history retries yield to the TUI event loop')
    assert.equal(loadHistory()[0]?.text, 'after live lock', 'append completes after lock release')
  } finally {
    clearTimeout(releaseLiveLock)
    rmSync(liveLock, { recursive: true, force: true })
  }

  // Ordering under contention: without a local append chain each call races the
  // file lock on its own, and the later input can land first.
  const orderingLock = join(fakeHome, '.dsh-tui', 'history.jsonl.lock')
  mkdirSync(orderingLock)
  const releaseOrderingLock = setTimeout(() => {
    rmSync(orderingLock, { recursive: true, force: true })
  }, 20)
  try {
    await Promise.all([
      appendHistory('order one'),
      appendHistory('order two'),
      appendHistory('order three'),
    ])
    assert.deepEqual(
      loadHistory().slice(0, 3).map(entry => entry.text),
      ['order three', 'order two', 'order one'],
      'concurrent appends persist in invocation order',
    )
  } finally {
    clearTimeout(releaseOrderingLock)
    rmSync(orderingLock, { recursive: true, force: true })
  }

  // Rename failure: appendHistory swallows the error, so the temp file holding
  // the user's raw input must still be removed.
  const historyFile = join(fakeHome, '.dsh-tui', 'history.jsonl')
  const historyBackup = readFileSync(historyFile, 'utf8')
  const dataDir = join(fakeHome, '.dsh-tui')
  rmSync(historyFile, { force: true })
  mkdirSync(join(historyFile, 'blocked'), { recursive: true })
  try {
    await appendHistory('rename failure')
    assert.equal(
      readdirSync(dataDir).some(name => name.endsWith('.tmp')),
      false,
      'a failed rename must not leave the input behind in a temp file',
    )
  } finally {
    rmSync(historyFile, { recursive: true, force: true })
    writeFileSync(historyFile, historyBackup, { encoding: 'utf8', mode: 0o600 })
  }

  const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { HistorySearchDialog }] =
    await Promise.all([
      import('node:stream'),
      import('react'),
      import('@xterm/headless'),
      import('../src/ui.js'),
      import('../src/components/HistorySearchDialog.js'),
    ])
  const terminal = new XTerm({ cols: 80, rows: 20, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = 80
    rows = 20
    isTTY = true
    _write(chunk, _encoding, callback) {
      terminal.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() {
      return this
    }
    ref() {
      return this
    }
    unref() {
      return this
    }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const lines = () =>
    Array.from({ length: 20 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '')
  const renderedText = () => lines().join('\n')
  const app = await render(
    React.createElement(HistorySearchDialog, {
      query: 'dup',
      cursorOffset: 3,
      matches: [
        { text: 'duplicate command', ts: Date.now() - 1000 },
        { text: 'duplicate command', ts: Date.now() - 2000 },
      ],
      focusIndex: 0,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.match(renderedText(), /duplicate command/, 'history dialog renders duplicate matches')
  app.rerender(
    React.createElement(HistorySearchDialog, {
      query: 'nomatch',
      cursorOffset: 7,
      matches: [],
      focusIndex: 0,
    }),
  )
  await new Promise(resolve => setTimeout(resolve, 100))
  const emptyRender = renderedText()
  assert.equal(emptyRender.includes('duplicate command'), false, 'empty history search clears old rows')
  assert.match(emptyRender, /没有匹配的命令|No matching commands/, 'empty history search shows empty state')
  app.unmount()

  const parallelHome = mkdtempSync(join(tmpdir(), 'dsh-tui-history-parallel-'))
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import',
        'tsx/esm',
        '--eval',
        "const { appendHistory } = await import('./src/history.ts'); await appendHistory(process.argv[1])",
        `parallel ${index}`,
      ], {
        cwd: workspace,
        env: { ...process.env, HOME: parallelHome, USERPROFILE: parallelHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', code => {
        if (code === 0) {
          resolve(undefined)
        } else {
          reject(new Error(`child ${index} exited ${code}: ${stderr}`))
        }
      })
    })))

    const parallelHistory = readFileSync(join(parallelHome, '.dsh-tui', 'history.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    assert.equal(parallelHistory.length, 20, 'parallel appends do not overwrite each other')
    assert.equal(new Set(parallelHistory.map(entry => entry.text)).size, 20)
  } finally {
    rmSync(parallelHome, { recursive: true, force: true })
  }
} finally {
  rmSync(fakeHome, { recursive: true, force: true })
}

console.log('history search OK (keys, nonblocking locks, empty render, capped persistence)')
