/**
 * Verification of the launcher-argument parsing (src/args.ts parseCcTuiArgs):
 * `dsh --profile cc-tui "prompt"` must produce an initial prompt, `-c` /
 * bare `--resume` must request the last-session marker, and `--resume <id>`
 * must pin a specific session — all independently of the DSH_CC_RESUME_SESSION
 * env the legacy dsh-cc wrappers feed. Also covers the branch edges: empty
 * `--resume=`, whitespace prompts, unknown flags, -h/--help, and combined
 * flags (explicit id wins over -c regardless of order).
 *
 * Run with plain node against the compiled lib: `node scripts/verify-cmdline-args.mjs`
 */
import { parseCcTuiArgs } from '../lib/types/args.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const SESSION = '4aa10d99-1443-4ae8-8c69-593ac3e7dfd3'
const fresh = { resumeId: undefined, continueLast: false, prompt: undefined, help: false }

const cases = [
  {
    name: 'positional prompt joins words',
    args: ['run', 'the', 'tests'],
    expect: { ...fresh, prompt: 'run the tests' },
  },
  {
    name: '-c alone resumes last session',
    args: ['-c'],
    expect: { ...fresh, continueLast: true },
  },
  {
    name: '-c with a prompt keeps both',
    args: ['-c', '继续干活'],
    expect: { ...fresh, continueLast: true, prompt: '继续干活' },
  },
  {
    name: '--resume <id> pins the session',
    args: ['--resume', SESSION],
    expect: { ...fresh, resumeId: SESSION },
  },
  {
    name: '--resume <id> + prompt',
    args: ['--resume', SESSION, 'run', 'the', 'tests'],
    expect: { ...fresh, resumeId: SESSION, prompt: 'run the tests' },
  },
  {
    name: 'bare --resume falls back to the last-session marker',
    args: ['--resume'],
    expect: { ...fresh, continueLast: true },
  },
  {
    name: '--resume=<id> form',
    args: ['--resume=abc-123'],
    expect: { ...fresh, resumeId: 'abc-123' },
  },
  {
    name: 'empty --resume= means the last session',
    args: ['--resume='],
    expect: { ...fresh, continueLast: true },
  },
  {
    name: '-r is an alias of --resume',
    args: ['-r', 'xyz'],
    expect: { ...fresh, resumeId: 'xyz' },
  },
  {
    name: 'no args means a fresh session',
    args: [],
    expect: { ...fresh },
  },
  {
    name: '--resume followed by another flag does not eat it',
    args: ['--resume', '--continue'],
    expect: { ...fresh, continueLast: true },
  },
  {
    name: '-h requests usage',
    args: ['-h'],
    expect: { ...fresh, help: true },
  },
  {
    name: '--help requests usage and is not a prompt',
    args: ['--help'],
    expect: { ...fresh, help: true },
  },
  {
    name: 'whitespace-only prompt is dropped',
    args: ['   ', '  '],
    expect: { ...fresh },
  },
  {
    name: 'unknown flag joins the prompt verbatim',
    args: ['--bogus', 'x'],
    expect: { ...fresh, prompt: '--bogus x' },
  },
  {
    name: 'explicit id wins over -c regardless of order',
    args: ['-c', '--resume', 'abc'],
    expect: { ...fresh, resumeId: 'abc', continueLast: true },
  },
  {
    name: '-r with a dash-leading value falls back to the marker',
    args: ['-r', '-x'],
    expect: { ...fresh, continueLast: true, prompt: '-x' },
  },
  {
    name: 'empty-string --resume value is passed through (plugin normalizes to fresh)',
    args: ['--resume', ''],
    expect: { ...fresh, resumeId: '' },
  },
]

for (const { name, args, expect } of cases) {
  const got = parseCcTuiArgs(args)
  const ok = JSON.stringify(got) === JSON.stringify(expect)
  check(name, ok, ok ? JSON.stringify(got) : `got ${JSON.stringify(got)} want ${JSON.stringify(expect)}`)
}

if (failed > 0) process.exit(1)
console.log(`\nAll ${cases.length} argument-parsing checks passed.`)
