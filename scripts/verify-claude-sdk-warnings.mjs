/**
 * Regression: the Claude SDK startup-warning filter
 * (src/backends/claude/sdk-warnings.ts, compiled to lib/types/). The honest
 * end-to-end is a CHILD node process importing the compiled module and
 * emitting both flavors: its stderr must carry the passthrough warning in
 * node's native shape and must NOT carry the suppressed one. (Node 24 fact
 * this locks in: the default warning printer still prints even with user
 * listeners, so a listener-based filter would silently do nothing.)
 * Run: node scripts/verify-claude-sdk-warnings.mjs
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isSuppressedSdkWarningCode } from '../lib/types/backends/claude/sdk-warnings.js'

const FILTER_MARKER = '__dshTuiSdkWarningFilter'
const pass = []
const fail = []
const check = (name, ok) => { (ok ? pass : fail).push(name); console.log((ok ? '  ok - ' : '  FAIL - ') + name) }

// Unit: the code gate.
check('shadow code recognized', isSuppressedSdkWarningCode('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'))
check('other code passes', !isSuppressedSdkWarningCode('SOMETHING_ELSE'))
check('undefined passes', !isSuppressedSdkWarningCode(undefined))

// Side effect in THIS process: emitWarning is wrapped (marker present).
check('emitWarning wrapper installed', Boolean(process.emitWarning?.[FILTER_MARKER]))

// End-to-end in a child: suppressed absent, passthrough present natively.
const moduleUrl = pathToFileURL(fileURLToPath(new URL('../lib/types/backends/claude/sdk-warnings.js', import.meta.url))).href
const childCode = 'await import(' + JSON.stringify(moduleUrl) + '); ' +
  'process.emitWarning("shadowed flavor", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" }); ' +
  'process.emitWarning("real flavor", "Type", "DSH_TEST_OTHER")'
const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], { encoding: 'utf8' })
const childErr = child.stderr ?? ''
check('child ran clean', child.status === 0)
check('suppressed warning absent from child stderr', !childErr.includes('shadowed flavor'))
check('suppressed code absent from child stderr', !childErr.includes('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'))
check('passthrough warning printed natively', childErr.includes('real flavor') && childErr.includes('DSH_TEST_OTHER'))

// Double-load idempotence: a second import must not re-wrap.
const childCode2 = 'await import(' + JSON.stringify(moduleUrl) + '); ' +
  'await import(' + JSON.stringify(moduleUrl + '?again=1') + '); ' +
  'process.emitWarning("shadowed 2", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" })'
const child2 = spawnSync(process.execPath, ['--input-type=module', '-e', childCode2], { encoding: 'utf8' })
check('double load stays suppressed', child2.status === 0 && !(child2.stderr ?? '').includes('shadowed 2'))

console.log(fail.length === 0 ? 'ALL PASS (' + pass.length + ')' : 'FAIL (' + fail.length + ' of ' + (pass.length + fail.length) + ')')
if (fail.length > 0) process.exit(1)
