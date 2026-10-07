/**
 * colorize chalk-level detection: a 256-color TERM is boosted to truecolor
 * inside VS Code (TERM_PROGRAM=vscode) and Windows Terminal (WT_SESSION,
 * forwarded into WSL); tmux still clamps back to 256 unless
 * DSH_TUI_TMUX_TRUECOLOR opts out. Levels are fixed at module load, so each
 * case runs in a fresh child process.
 *
 * Run: `node --import tsx/esm scripts/verify-chalk-truecolor-boost.ts`
 */
import { execFileSync } from 'node:child_process'

const probe = `
const { default: chalk } = await import('chalk')
await import('./src/ink/colorize.ts')
process.stdout.write(String(chalk.level))
`

function levelWith(extra: Record<string, string>): number {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of ['TERM_PROGRAM', 'WT_SESSION', 'TMUX', 'COLORTERM', 'DSH_TUI_TMUX_TRUECOLOR', 'FORCE_COLOR', 'NO_COLOR', 'CI']) delete env[key]
  // Enable color for the pipe without forcing a numeric level; chalk still
  // detects 256 colors from TERM, just as it does on a real TTY.
  Object.assign(env, { TERM: 'xterm-256color', FORCE_COLOR: 'true' }, extra)
  const out = execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', probe], { env, encoding: 'utf8' })
  return Number(out.trim())
}

let failed = 0
const check = (name: string, got: number, want: number) => {
  const ok = got === want
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : `  (level=${got}, want ${want})`}`)
  if (!ok) failed++
}

check('plain 256-color TERM stays 256', levelWith({}), 2)
check('VS Code boosts to truecolor', levelWith({ TERM_PROGRAM: 'vscode' }), 3)
check('Windows Terminal (WT_SESSION) boosts to truecolor', levelWith({ WT_SESSION: 'wt' }), 3)
check('tmux inside Windows Terminal clamps to 256', levelWith({ WT_SESSION: 'wt', TMUX: '/tmp/tmux' }), 2)
check('DSH_TUI_TMUX_TRUECOLOR keeps truecolor in tmux', levelWith({ WT_SESSION: 'wt', TMUX: '/tmp/tmux', DSH_TUI_TMUX_TRUECOLOR: '1' }), 3)
check('Windows Terminal respects FORCE_COLOR=2', levelWith({ WT_SESSION: 'wt', FORCE_COLOR: '2' }), 2)
check('FORCE_COLOR=0 is never boosted', levelWith({ WT_SESSION: 'wt', FORCE_COLOR: '0' }), 0)

console.log(failed === 0 ? 'verify-chalk-truecolor-boost: all assertions passed' : `verify-chalk-truecolor-boost: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
