/**
 * Smart preference and fork-state resolution regression.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 *   node scripts/verify-smart-state.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const testHome = mkdtempSync(join(tmpdir(), 'dsh-tui-smart-state-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome

function cleanup() {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  rmSync(testHome, { recursive: true, force: true })
}

let smartPrefs
try {
  smartPrefs = await import('../lib/types/smartPrefs.js')
} catch (error) {
  cleanup()
  throw error
}

const {
  readSmartDefault,
  readSmartSession,
  resolvePersistedSmart,
  smartModeOf,
  writeSmartDefault,
  writeSmartSession,
} = smartPrefs

const prefsDir = join(testHome, '.dsh-tui')
const prefsFile = join(prefsDir, 'smart.json')

function requestHeader(seq, system = 'base system') {
  return {
    type: 'request/header',
    seq,
    time: seq,
    data: {
      header: {
        system,
        tools: [{ name: 'read' }],
      },
    },
  }
}

function session(id, seedLength, events) {
  return { header: { id, seedLength }, events }
}

test('Smart default and per-session state persist independently', () => {
  assert.equal(readSmartDefault(), undefined)
  assert.equal(readSmartSession('alpha'), undefined)

  assert.equal(writeSmartDefault(true), true)
  assert.equal(writeSmartSession('alpha', false), true)
  assert.equal(readSmartDefault(), true)
  assert.equal(readSmartSession('alpha'), false)

  assert.equal(writeSmartDefault(false), true)
  assert.equal(readSmartDefault(), false)
  assert.equal(readSmartSession('alpha'), false)
})

test('a fork child uses only its sidecar even when inherited prompts disagree', () => {
  const inherited = requestHeader(3, 'Smart task routing is active')
  const child = session('child-before-request', 4, [inherited])

  assert.equal(smartModeOf(child, false), false)
  assert.equal(smartModeOf(child, true), true)
  assert.equal(smartModeOf(child, undefined), false)
})

test('the sidecar remains authoritative over child-local prompt text', () => {
  const inheritedOn = requestHeader(3, 'Smart task routing is active')
  assert.equal(
    smartModeOf(session('child-off', 4, [inheritedOn, requestHeader(4)]), true),
    true,
  )

  const inheritedOff = requestHeader(3)
  assert.equal(
    smartModeOf(session('child-on', 4, [inheritedOff, requestHeader(4, 'Smart task routing is active')]), false),
    false,
  )
})

test('request headers never become an enhancement state channel', () => {
  assert.equal(
    smartModeOf(session('ordinary-on', undefined, [requestHeader(0, 'Smart task routing is active')]), undefined),
    false,
  )
  assert.equal(smartModeOf(session('legacy-empty', undefined, []), undefined), false)
})

test('persisted resolution applies sidecar precedence', async () => {
  writeSmartSession('persisted-child', true)
  const persisted = session('persisted-child', 2, [requestHeader(1, 'contradictory prompt'), requestHeader(2)])
  const ctx = {
    get(name) {
      if (name !== 'sessionPersistence') return undefined
      return {
        async load(id) {
          assert.equal(String(id), 'persisted-child')
          return { meta: persisted.header, events: persisted.events }
        },
      }
    },
  }
  assert.equal(await resolvePersistedSmart(ctx, 'persisted-child'), true)
})

test('request headers retain explicit sidecar state', () => {
  const promptOnly = session('prompt-only', 0, [requestHeader(0)])
  assert.equal(smartModeOf(promptOnly, true), true)
  assert.equal(smartModeOf(promptOnly, false), false)
  assert.equal(smartModeOf(promptOnly, undefined), false)
})

test('corrupt preference data fails closed', () => {
  writeFileSync(prefsFile, '{ definitely not json', 'utf8')
  assert.equal(readSmartDefault(), undefined)
  assert.equal(readSmartSession('alpha'), undefined)
})

test.after(() => {
  cleanup()
})
