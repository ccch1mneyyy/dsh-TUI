/** Small file fixtures only; never starts DSH or creates a real heap snapshot.
 * Run: node --import tsx/esm scripts/verify-heap-watch-retention.ts
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeapWatchLog, pruneHeapWatchFiles } from './lib/heap-watch-retention.js'

const directory = mkdtempSync(join(tmpdir(), 'verify-heap-watch-'))
const prefix = (pid: number): string => `dsh-tui-heap-watch-123-${pid}-${randomUUID()}`
const savedKill = process.kill
try {
  const first = prefix(101)
  const second = prefix(102)
  assert.notEqual(first, second, 'concurrent samplers have distinct names')
  const logFile = join(directory, `${first}.log`)
  const log = createHeapWatchLog(logFile)
  log('a'.repeat(64 * 1024))
  log('latest diagnostic\n')
  assert.equal(statSync(logFile).size, 64 * 1024)
  assert.ok(readFileSync(logFile, 'utf8').endsWith('latest diagnostic\n'))
  assert.ok(!existsSync(`${logFile}.writing`))

  const fixtures: string[] = []
  for (let index = 0; index < 4; index++) {
    const file = join(directory, `${first}-${1024 + index}mb.heapsnapshot`)
    writeFileSync(file, '123456')
    utimesSync(file, index + 1, index + 1)
    fixtures.push(file)
  }
  const manual = join(directory, 'heap-manual.heapsnapshot')
  writeFileSync(manual, 'untouched')
  const live = join(directory, `${second}-1024mb.heapsnapshot.writing`)
  const dead = join(directory, `${prefix(103)}-1024mb.heapsnapshot.writing`)
  const denied = join(directory, `${prefix(104)}.log.writing`)
  for (const file of [live, dead, denied]) writeFileSync(file, 'incomplete')
  process.kill = ((pid: number, signal: string | number) => {
    assert.equal(signal, 0, 'owner checks never send a terminating signal')
    if (pid === 103) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    if (pid === 104) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    assert.equal(pid, 102)
    return true
  }) as typeof process.kill
  pruneHeapWatchFiles(directory, 2, 12)
  assert.deepEqual(fixtures.map(existsSync), [false, false, true, true])
  assert.ok(existsSync(manual))
  assert.ok(existsSync(live), 'another live process keeps its incomplete snapshot')
  assert.ok(existsSync(denied), 'uncertain ownership is preserved')
  assert.ok(!existsSync(dead), 'only a confirmed dead owner is reaped')

  const oversized = join(directory, `${second}-2048mb.heapsnapshot`)
  writeFileSync(oversized, 'x'.repeat(13))
  pruneHeapWatchFiles(directory, 2, 12)
  assert.ok(!existsSync(oversized), 'even the newest snapshot must fit the byte budget')
  assert.ok(existsSync(logFile), 'the diagnostic log remains when a snapshot is too large')
  pruneHeapWatchFiles(directory, 2, 6)
  assert.equal(fixtures.filter(existsSync).length, 1, 'byte budget can be tighter than count budget')

  for (let index = 0; index < 6; index++) {
    createHeapWatchLog(join(directory, `${prefix(101)}.log`))(`log ${index}`)
  }
  pruneHeapWatchFiles(directory, 2, 12)
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.log')).length, 4)
  assert.doesNotThrow(() => pruneHeapWatchFiles(join(directory, 'missing'), 2, 12))
  assert.throws(() => createHeapWatchLog(join(directory, 'missing', 'log'))('line'))
  // A matching symlink is not one of the script's completed regular files.
  if (process.platform !== 'win32') {
    const link = join(directory, `${prefix(101)}.log`)
    symlinkSync(manual, link)
    pruneHeapWatchFiles(directory, 0, 0)
    assert.ok(existsSync(link))
    assert.equal(readFileSync(manual, 'utf8'), 'untouched')
  }
} finally {
  process.kill = savedKill
  rmSync(directory, { recursive: true, force: true })
}
console.log('verify-heap-watch-retention: all checks passed')
