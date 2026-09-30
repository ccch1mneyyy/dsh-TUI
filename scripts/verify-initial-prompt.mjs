#!/usr/bin/env node
/**
 * Regression: startup flag values are not prompt text, but tokens after -- are.
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
  ['absent argv has no prompt', undefined, ''],
  ['empty argv has no prompt', [], ''],
  ['plain positionals become prompt', ['run', 'the tests'], 'run the tests'],
  ['flag-shaped args are ignored', ['--fullscreen', 'run'], 'run'],
  ['--resume value is not prompt', ['--resume', '22ee1032-c765-487e-a22f-9bd0d1c9e4cc'], ''],
  ['--resume=value is not prompt', ['--resume=22ee1032-c765-487e-a22f-9bd0d1c9e4cc'], ''],
  ['explicit prompt after --resume still works', ['--resume', 'sid-1', 'follow', 'up'], 'follow up'],
  ['--host value is not prompt', ['--host', '127.0.0.1'], ''],
  ['--port value is not prompt', ['--port', '3099'], ''],
  ['--trusted-host value is not prompt', ['--trusted-host', 'myhost:3080'], ''],
  ['--trusted-host consumes all authorities', ['--trusted-host', 'a:1', 'b:2'], ''],
  ['combined Web flags have no prompt', ['--no-open', '--host', '127.0.0.1', '--port', '3099', '--trusted-host', 'a:1', 'b:2'], ''],
  ['repeated variadic flags have no prompt', ['--trusted-host', 'a:1', 'b:2', '--trusted-host', 'c:3', 'd:4'], ''],
  ['positionals before --host still work', ['run', 'the tests', '--host', '127.0.0.1'], 'run the tests'],
  ['positionals before --trusted-host still work', ['run', 'the tests', '--trusted-host', 'a:1', 'b:2'], 'run the tests'],
  ['single-value flags preserve following positionals', ['--host', '127.0.0.1', '--port', '3099', 'follow', 'up'], 'follow up'],
  ['variadic values stop at the next value-taking flag', ['--trusted-host', 'a:1', 'b:2', '--port', '3099', 'follow', 'up'], 'follow up'],
  ['variadic values stop at a boolean flag', ['--trusted-host', 'a:1', 'b:2', '--fullscreen', 'run'], 'run'],
  ['missing values do not consume the next flag', ['--resume', '--host', '--port', '--trusted-host', '--fullscreen', 'run'], 'run'],
  ['missing value at argv end is tolerated', ['run', '--host'], 'run'],
  ['empty variadic values at argv end are tolerated', ['run', '--trusted-host'], 'run'],
  ['inline Web flag values are not prompt', ['--host=127.0.0.1', '--port=3099', '--trusted-host=a:1'], ''],
  ['inline single-value flags preserve positionals', ['--host=127.0.0.1', '--port=3099', 'follow', 'up'], 'follow up'],
  ['boolean Web flag has no prompt', ['--no-open'], ''],
  ['-- preserves a literal --host prompt', ['--', '--host', 'example'], '--host example'],
  ['-- preserves all flag-shaped prompt tokens', ['--', '--port', '3099', '--trusted-host', 'a:1', 'b:2', '--resume=sid-1', '--fullscreen'], '--port 3099 --trusted-host a:1 b:2 --resume=sid-1 --fullscreen'],
  ['-- retains preceding prompt text', ['explain', '--', '--host', 'example'], 'explain --host example'],
  ['-- ends option parsing after single-value flags', ['--resume', 'sid-1', '--host', '127.0.0.1', '--port', '3099', '--', '--resume', 'example'], '--resume example'],
  ['-- ends variadic values and preserves the prompt', ['--trusted-host', 'a:1', 'b:2', '--', '--host', 'example'], '--host example'],
  ['missing flag value does not consume --', ['--host', '--', '--port', 'example'], '--port example'],
  ['empty variadic values do not consume --', ['--trusted-host', '--', '--host', 'example'], '--host example'],
  ['only the first -- is a separator', ['--', '--', '--host', 'example'], '-- --host example'],
  ['-- alone has no prompt', ['--'], ''],
  ['trailing -- preserves existing prompt text', ['run', 'the tests', '--'], 'run the tests'],
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
