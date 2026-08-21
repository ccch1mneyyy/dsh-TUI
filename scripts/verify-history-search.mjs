import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

  appendHistory('你好')
  appendHistory('知道')
  appendHistory('你好')
  assert.deepEqual(
    loadHistory().map(entry => entry.text),
    ['你好', '知道', '你好'],
    'non-consecutive duplicate history entries should remain searchable',
  )

  for (let index = 0; index < 250; index += 1) {
    appendHistory(`cmd ${index}`)
  }
  const capped = loadHistory()
  assert.equal(capped.length, 200, 'persisted history stays capped')
  assert.equal(capped[0]?.text, 'cmd 249')
  assert.equal(capped.at(-1)?.text, 'cmd 50')

  const parallelHome = mkdtempSync(join(tmpdir(), 'dsh-tui-history-parallel-'))
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import',
        'tsx/esm',
        '--eval',
        "const { appendHistory } = await import('./src/history.ts'); appendHistory(process.argv[1])",
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

console.log('history search OK (unique duplicate keys, filtering data, capped persistence)')
