/**
 * fullscreenPrefs tests: the /settings `fullscreen` toggle mirrors its choice
 * to ~/.dsh-tui/fullscreen.json so the next boot can read it synchronously
 * (the cordis inject callback always runs after the bootstrap). Covers the
 * read/write round-trip plus the corrupt/missing-file fallback.
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFullscreenPref, writeFullscreenPref } from '../../src/fullscreenPrefs.js'

function prefsDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-tui-fullscreen-prefs-'))
}

test('fullscreenPrefs: read returns undefined when the file is missing', () => {
  assert.equal(readFullscreenPref(prefsDir()), undefined)
})

test('fullscreenPrefs: write/read round-trips both values', () => {
  const dir = prefsDir()
  assert.equal(writeFullscreenPref(true, dir), true)
  assert.equal(readFullscreenPref(dir), true)
  assert.equal(writeFullscreenPref(false, dir), true)
  assert.equal(readFullscreenPref(dir), false)
})

test('fullscreenPrefs: read tolerates corrupt JSON and wrong shapes', () => {
  const dir = prefsDir()
  const file = join(dir, 'fullscreen.json')
  writeFileSync(file, 'not json{')
  assert.equal(readFullscreenPref(dir), undefined)
  writeFileSync(file, JSON.stringify({ fullscreen: 'yes' }))
  assert.equal(readFullscreenPref(dir), undefined)
  writeFileSync(file, JSON.stringify([true]))
  assert.equal(readFullscreenPref(dir), undefined)
})
