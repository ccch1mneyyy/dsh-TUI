/**
 * Regression: the win32 console code page is switched to UTF-8 before the
 * first frame — read first, write only on a mismatch, never with
 * `windowsHide`, and never a spawn off Windows.
 *
 * Why each assertion exists (all measured on a real machine 2026-09-21):
 *  - the page decides how native children encode their output while the dsh
 *    subprocess layer decodes every stream as UTF-8, so it must be UTF-8;
 *  - a page WRITE makes the console re-emit its buffer, which wipes the
 *    splash when it lands after the first frame — so a console that already
 *    reports UTF-8 must not be written to;
 *  - `windowsHide` maps to CREATE_NO_WINDOW, whose child has no console
 *    handle, so `chcp.com` silently changes nothing (the host-side half of the
 *    retired dsh-console-utf8 plugin failed exactly this way for weeks).
 *
 * Run: node --import tsx/esm scripts/verify-console-codepage.ts
 */
import assert from 'node:assert/strict'

import { ensureUtf8ConsolePage, parseCodePage, UTF8_CODE_PAGE } from '../src/terminal-utils/consoleCodePage.js'
import type { ConsoleSpawnSync } from '../src/terminal-utils/consoleCodePage.js'

/** A console whose page really changes, recording every spawn. */
function makeConsole(initial: number) {
  const record: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = []
  let current = initial
  const spawnSync: ConsoleSpawnSync = (command, args, options) => {
    record.push({ command, args, options })
    if (args.length === 1 && /^\d+$/.test(args[0])) current = Number(args[0])
    return { status: 0, stdout: `Active code page: ${current}\r\n` }
  }
  return { record, spawnSync, page: () => current }
}

/** A console that already reports UTF-8: the switch must not be issued. */
{
  const consoleState = makeConsole(936)
  const result = ensureUtf8ConsolePage({ platform: 'win32', spawnSync: consoleState.spawnSync })

  assert.deepEqual(result, { before: 936, after: 65001, switched: true })
  assert.deepEqual(consoleState.record.map(call => call.args), [[], ['65001'], []])
  assert.equal(consoleState.page(), 65001)
  for (const call of consoleState.record) {
    assert.equal(call.command, 'chcp.com', 'only chcp.com is ever spawned')
    // The load-bearing detail: an attached child keeps the console handle.
    assert.equal('windowsHide' in call.options, false, 'chcp must attach to the console')
  }
  console.log('PASS: 936 -> 65001 through an attached chcp.com')
}

/** Already UTF-8: a write would re-emit the buffer for nothing. */
{
  const consoleState = makeConsole(65001)
  const result = ensureUtf8ConsolePage({ platform: 'win32', spawnSync: consoleState.spawnSync })

  assert.deepEqual(result, { before: 65001, after: 65001, switched: false })
  assert.equal(consoleState.record.length, 1, 'a matching page must not be written to')
  console.log('PASS: an already-UTF-8 console is left untouched')
}

/** Off Windows the console is not ours to touch. */
{
  let calls = 0
  const spawnSync: ConsoleSpawnSync = () => {
    calls += 1
    return { status: 0, stdout: '' }
  }
  for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
    assert.deepEqual(
      ensureUtf8ConsolePage({ platform, spawnSync }),
      { before: undefined, after: undefined, switched: false },
    )
  }
  assert.equal(calls, 0, 'no child process off win32')
  console.log('PASS: no console work off win32')
}

/** Fail-open: a missing chcp.com, a throwing spawner, a refused switch. */
{
  const throwing: ConsoleSpawnSync = () => {
    throw new Error('spawnSync chcp.com ENOENT')
  }
  assert.deepEqual(
    ensureUtf8ConsolePage({ platform: 'win32', spawnSync: throwing }),
    { before: undefined, after: undefined, switched: false },
  )

  const refused: ConsoleSpawnSync = () => ({ status: 1, stdout: 'Active code page: 936\r\n' })
  assert.equal(ensureUtf8ConsolePage({ platform: 'win32', spawnSync: refused }).switched, false)

  const empty: ConsoleSpawnSync = () => undefined
  assert.deepEqual(
    ensureUtf8ConsolePage({ platform: 'win32', spawnSync: empty }),
    { before: undefined, after: undefined, switched: false },
  )
  console.log('PASS: fail-open when chcp.com is absent, refuses, or answers nothing')
}

/** parseCodePage: localised text, raw bytes, junk. */
{
  assert.equal(parseCodePage('Active code page: 65001\r\n'), 65001)
  assert.equal(parseCodePage('活动代码页: 936\r\n'), 936)
  assert.equal(parseCodePage(Buffer.from('Active code page: 932\r\n')), 932)
  assert.equal(parseCodePage('nonsense'), undefined)
  assert.equal(parseCodePage(undefined), undefined)
  assert.equal(UTF8_CODE_PAGE, 65001)
  console.log('PASS: parseCodePage reads localised and byte output, rejects junk')
}

console.log('\nALL PASS')
