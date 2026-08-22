#!/usr/bin/env node
/** Regression: persisted history survives concurrent writers and bad timestamps. */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-history-persistence-'))
process.env.HOME = home
process.env.USERPROFILE = home

const historyDir = join(home, '.dsh-tui')
const historyFile = join(historyDir, 'history.jsonl')
const historyModule = pathToFileURL(resolve('lib/types/history.js')).href
const { appendHistory, loadHistory } = await import(historyModule)

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed += 1
}

function appendInChild(text) {
  const source = `
    const { appendHistory } = await import(${JSON.stringify(historyModule)});
    appendHistory(process.env.HISTORY_TEST_TEXT);
  `
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, HOME: home, USERPROFILE: home, HISTORY_TEST_TEXT: text },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolveChild()
      else reject(new Error(`history writer exited ${code}: ${stderr}`))
    })
  })
}

try {
  mkdirSync(historyDir, { recursive: true })
  writeFileSync(historyFile, [
    JSON.stringify({ text: 'negative timestamp', ts: -1 }),
    JSON.stringify({ text: 'missing timestamp' }),
    JSON.stringify({ text: 'repeat', ts: 100 }),
    JSON.stringify({ text: 'repeat', ts: 200 }),
    JSON.stringify({ text: 'separator', ts: 300 }),
    JSON.stringify({ text: 'repeat', ts: 400 }),
  ].join('\n') + '\n')

  const parsed = loadHistory()
  check(
    'invalid timestamps are normalized to finite non-negative values',
    parsed.every(entry => Number.isFinite(entry.ts) && entry.ts >= 0),
  )
  check(
    'only adjacent duplicate entries collapse',
    parsed.map(entry => entry.text).join('|') ===
      'repeat|separator|repeat|missing timestamp|negative timestamp',
    parsed.map(entry => entry.text).join('|'),
  )

  writeFileSync(historyFile, JSON.stringify({ text: 'legacy-no-newline', ts: 1 }))
  appendHistory('after-boundary')
  const repairedBoundary = loadHistory()
  check(
    'append repairs a missing terminal newline',
    repairedBoundary.map(entry => entry.text).join('|') === 'after-boundary|legacy-no-newline',
    repairedBoundary.map(entry => entry.text).join('|'),
  )

  writeFileSync(
    historyFile,
    Array.from({ length: 250 }, (_, index) =>
      JSON.stringify({ text: `bounded-${index}`, ts: index }),
    ).join('\n') + '\n',
  )
  const bounded = loadHistory()
  check(
    'history search exposes only the latest 200 entries',
    bounded.length === 200 && bounded[0]?.text === 'bounded-249' && bounded[199]?.text === 'bounded-50',
  )

  writeFileSync(historyFile, '')
  for (let index = 0; index < 250; index += 1) {
    appendHistory(`bounded-write-${index}`)
  }
  const persistedBoundedLines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)
  check('append keeps the physical history file bounded', persistedBoundedLines.length === 200)

  writeFileSync(historyFile, '')
  const texts = Array.from({ length: 32 }, (_, index) => `writer-${index}`)
  await Promise.all(texts.map(appendInChild))

  const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)
  const records = lines.map(line => JSON.parse(line))
  check('concurrent writers leave complete JSONL records', records.length === texts.length)
  check(
    'concurrent writers do not overwrite one another',
    new Set(records.map(record => record.text)).size === texts.length &&
      texts.every(text => records.some(record => record.text === text)),
  )
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failed > 0) process.exit(1)
console.log('verify-history-persistence OK')
