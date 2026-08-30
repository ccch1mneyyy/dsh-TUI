/**
 * Verification of slash-command auto-complete when used mid-message (not as the first word).
 * Run with node: `node scripts/verify-command-mid-message.mjs`
 */
import { commandAtCaret, completeCommands, LOCAL_COMMANDS } from '../lib/types/commands.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// 1. Root command at line start
const root = commandAtCaret('/hel', 4)
check('root command at start of input', root !== undefined && root.start === 0 && root.query === '/hel', JSON.stringify(root))
const rootCompletions = completeCommands(root?.query ?? '', LOCAL_COMMANDS)
check('root command completions include /help', rootCompletions.some(c => c.name === 'help'), JSON.stringify(rootCompletions.map(c => c.name)))

// 2. Mid-message command token
const mid = commandAtCaret('please run /cle now', 15)
check('mid-message command token detected', mid !== undefined && mid.start === 11 && mid.end === 15 && mid.query === '/cle', JSON.stringify(mid))
const midCompletions = completeCommands(mid?.query ?? '', LOCAL_COMMANDS)
check('mid-message completions include /clear', midCompletions.some(c => c.name === 'clear'), JSON.stringify(midCompletions.map(c => c.name)))

// 3. URLs and file paths must not trigger command completion
const url = commandAtCaret('visit https://example.com/api/test', 30)
check('URL path is not detected as a command', url === undefined, JSON.stringify(url))

const filePath = commandAtCaret('check src/components/PromptInput.tsx', 20)
check('file path slash is not detected as a command', filePath === undefined, JSON.stringify(filePath))

// 4. Multiline inputs disable slash command completion
const multi = commandAtCaret('first line\n/cle', 15)
check('multiline input returns undefined', multi === undefined, JSON.stringify(multi))

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll mid-message command completion checks passed')
}
