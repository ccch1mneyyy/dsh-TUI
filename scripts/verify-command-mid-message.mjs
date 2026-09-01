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

// 3. Consecutive slash commands one after the other
const multiCmd = '/improve-codebase-architecture /code-review /pon'
const multiCaret = commandAtCaret(multiCmd, multiCmd.length)
check('consecutive command token detected at end of input', multiCaret !== undefined && multiCaret.start === 44 && multiCaret.end === 48 && multiCaret.query === '/pon', JSON.stringify(multiCaret))
const skillCompletions = completeCommands(multiCaret?.query ?? '', [{ name: 'ponytail-audit', description: 'Audit' }, ...LOCAL_COMMANDS])
check('consecutive command completes matching candidates', skillCompletions.some(c => c.name === 'ponytail-audit'), JSON.stringify(skillCompletions.map(c => c.name)))

// 4. Trailing slash immediately following a previous command and space
const trailingSlash = '/improve-codebase-architecture /'
const trailingCaret = commandAtCaret(trailingSlash, trailingSlash.length)
check('trailing slash after previous command detected', trailingCaret !== undefined && trailingCaret.start === 31 && trailingCaret.end === 32 && trailingCaret.query === '/', JSON.stringify(trailingCaret))
const allCompletions = completeCommands(trailingCaret?.query ?? '', LOCAL_COMMANDS)
check('trailing slash surfaces all root commands', allCompletions.length >= LOCAL_COMMANDS.length, `count: ${allCompletions.length}`)

// 5. Root command with subcommands
const subCmd = '/workspace res'
const subCaret = commandAtCaret(subCmd, subCmd.length)
check('root command with subcommand detected', subCaret !== undefined && subCaret.start === 0 && subCaret.end === 14 && subCaret.query === '/workspace res', JSON.stringify(subCaret))
const subCompletions = completeCommands(subCaret?.query ?? '', [{ name: 'workspace', description: 'Workspace' }], () => [{ name: 'resume', description: 'Resume' }])
check('root command completes subcommand', subCompletions.some(c => c.name === 'workspace resume'), JSON.stringify(subCompletions.map(c => c.name)))

// 6. URLs and file paths must not trigger command completion
const url = commandAtCaret('visit https://example.com/api/test', 30)
check('URL path is not detected as a command', url === undefined, JSON.stringify(url))

const filePath = commandAtCaret('check src/components/PromptInput.tsx', 20)
check('file path slash is not detected as a command', filePath === undefined, JSON.stringify(filePath))

// 7. Multiline inputs disable slash command completion
const multi = commandAtCaret('first line\n/cle', 15)
check('multiline input returns undefined', multi === undefined, JSON.stringify(multi))

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll mid-message command completion checks passed')
}
