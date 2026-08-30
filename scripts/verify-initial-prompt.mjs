#!/usr/bin/env node
/**
 * Regression: launch-time --resume carries a session id, not prompt text.
 *
 * Run after build:
 *   node scripts/verify-initial-prompt.mjs
 */
import { initialPromptFromCmdlineArgs } from '../lib/types/dsh-adapter/plugin.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const cases = [
  ['plain positionals become prompt', ['run', 'the tests'], 'run the tests'],
  ['flag-shaped args are ignored', ['--fullscreen', 'run'], 'run'],
  ['--resume value is not prompt', ['--resume', '22ee1032-c765-487e-a22f-9bd0d1c9e4cc'], ''],
  ['--resume=value is not prompt', ['--resume=22ee1032-c765-487e-a22f-9bd0d1c9e4cc'], ''],
  ['explicit prompt after --resume still works', ['--resume', 'sid-1', 'follow', 'up'], 'follow up'],
]

for (const [name, args, expected] of cases) {
  const actual = initialPromptFromCmdlineArgs(args)
  check(name, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

if (failed > 0) {
  console.error(`verify-initial-prompt: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-initial-prompt OK')
