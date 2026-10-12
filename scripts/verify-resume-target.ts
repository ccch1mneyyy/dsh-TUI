/**
 * B-2a: startup recovery fails closed (roadmap §6 item 11).
 *
 * The decision, verbatim: recovery only ever targets the selected backend, a
 * derived target is bound to the backend it came from, and "the backend is
 * unavailable / there is no last session / the named session does not exist" all
 * refuse loudly with a non-zero exit instead of falling back, resuming another
 * backend's session, or quietly starting a new one. This script pins the pure
 * half (`resolveResumeTarget`, `resumeTargetFromArgv`), the launcher half (a bare
 * request it cannot derive refuses instead of handing `--continue` downstream, and
 * the safe-mode retry is the one tolerated case), and the two invariants the
 * refusal path must not break: the rescue profile's dropped env, and the
 * replacement env of /restart.
 *
 * The boot half — the two refusal branches themselves — runs for real in
 * scripts/verify-startup-argv.mjs, which lifts them out of the compiled plugin and
 * evaluates them against the real launcher.
 *
 * Run: node --import tsx/esm scripts/verify-resume-target.ts (no build needed)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RESUME_BACKEND_ENV, RESUME_RETRY_ENV, resolveResumeTarget, type ResumeTarget } from '../src/kernelPrefs.js'
import { resumeTargetFromArgv } from '../src/sessionHistory.js'
import { restartChildEnv } from '../src/update.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const targetOf = (input: Parameters<typeof resolveResumeTarget>[0]): ResumeTarget => resolveResumeTarget(input)

// ── The discriminated union, case by case ─────────────────────────────────────
check('no request, a blank id and a whitespace id are all "none"',
  targetOf({ backendChoice: 'dsh' }).kind === 'none'
    && targetOf({ sessionId: '', sourceBackend: 'claude', backendChoice: 'dsh' }).kind === 'none'
    && targetOf({ sessionId: '   ', sourceBackend: 'claude', backendChoice: 'dsh' }).kind === 'none')

const usable = targetOf({ sessionId: 'typed-1', backendChoice: 'dsh' })
check('an unmarked target is usable: the user placed it, the host does not vouch for it',
  usable.kind === 'usable' && usable.sessionId === 'typed-1')
const sameSource = targetOf({ sessionId: 'claude-1', sourceBackend: 'claude', backendChoice: 'claude' })
check('a marked target whose source is the backend this boot landed on is usable',
  sameSource.kind === 'usable' && sameSource.sessionId === 'claude-1')

const revoked = targetOf({ sessionId: 'codex-1', sourceBackend: 'codex', backendChoice: 'dsh' })
check('a marked target from another backend is revoked, with its source and no id',
  revoked.kind === 'revoked' && revoked.from === 'codex' && !('sessionId' in revoked))
check('...and it is fatal by default: the boot refuses, it does not cold-start',
  revoked.kind === 'revoked' && revoked.fatal === true)
const tolerated = targetOf({ sessionId: 'codex-1', sourceBackend: 'codex', backendChoice: 'dsh', retry: true })
check('the retry flag is the one tolerated branch: still revoked, no longer fatal',
  tolerated.kind === 'revoked' && tolerated.from === 'codex' && tolerated.fatal === false)
check('a retry does not resurrect the target either — the cold start is the point',
  !('sessionId' in tolerated))

// ── resumeTargetFromArgv: the grammar the in-profile boot shares with the bin ─
const fallbackCalls = (argv: readonly string[], fallback: () => string | undefined) => {
  let calls = 0
  const value = resumeTargetFromArgv(argv, () => {
    calls += 1
    return fallback()
  })
  return { value, calls }
}
const marker = () => 'remembered-session'
check('an explicit id is used as given and never asks for a fallback',
  fallbackCalls(['--resume', 'sid-1'], marker).value === 'sid-1'
    && fallbackCalls(['--resume', 'sid-1'], marker).calls === 0
    && fallbackCalls(['--resume=sid-1'], marker).value === 'sid-1'
    && fallbackCalls(['--resume=sid-1'], marker).calls === 0)
check('a bare flag (--resume, -c, --continue) resolves through the caller fallback',
  fallbackCalls(['--resume'], marker).value === 'remembered-session'
    && fallbackCalls(['-c'], marker).value === 'remembered-session'
    && fallbackCalls(['--continue'], marker).value === 'remembered-session')
check('an empty fallback stays empty: the caller decides to refuse, not to invent an id',
  fallbackCalls(['--resume'], () => undefined).value === undefined
    && fallbackCalls(['--resume'], () => '').value === undefined)
check('a flag after a bare flag is not consumed as its id',
  fallbackCalls(['--resume', '--backend', 'claude'], marker).value === 'remembered-session'
    && fallbackCalls(['--resume', '--backend', 'claude'], marker).calls === 1)
check('the first resume flag wins, exactly like the bin',
  fallbackCalls(['--resume', 'first', '--resume', 'second'], marker).value === 'first')
check('an app-level -- ends option parsing: nothing behind it is a resume request',
  fallbackCalls(['--', '--resume'], marker).value === undefined
    && fallbackCalls(['--', '--resume'], marker).calls === 0
    && fallbackCalls(['--resume', '--', '--continue'], marker).value === 'remembered-session')

// ── The launcher half: source-level, because bin/dsh-tui.js is a script ──────
const launcher = readFileSync(fileURLToPath(new URL('../bin/dsh-tui.js', import.meta.url)), 'utf8')
/** The rescue profile's explicit env construction: the dropped names, in order. */
const rescueDropped = (source: string): string[] => {
  const list = /const RESCUE_DROPPED_ENV = \[([^\]]*)\]/u.exec(source)
  assert.ok(list !== null, 'launcher: RESCUE_DROPPED_ENV exists')
  return [...list[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]!)
}
/** The last-bare-request block: does it refuse instead of injecting --continue? */
const bareRequestBlock = (source: string): string => {
  const at = source.indexOf('if (resumeFlags.at(-1) === null) {')
  assert.ok(at >= 0, 'launcher: the final bare resume request block exists')
  const end = source.indexOf('\n  }\n', at)
  assert.ok(end > at, 'launcher: the final bare resume request block is closed')
  return source.slice(at, end)
}
const refusesBareRequest = (source: string): boolean => {
  const block = bareRequestBlock(source)
  return block.includes("msg('resumeNoLastSession')") && block.includes('process.exit(1)')
}
const retryEnvMarker = (source: string): string | undefined =>
  /const RESUME_RETRY_ENV = '([^']+)'/u.exec(source)?.[1]
const retryEnvAddsMarker = (source: string): boolean => {
  const at = source.indexOf('const resumeEnvForRetry =')
  assert.ok(at >= 0, 'launcher: resumeEnvForRetry exists')
  const line = source.slice(at, source.indexOf('\n', at))
  return line.includes('resumeEnvForRetryTarget') && /\[RESUME_RETRY_ENV\]: '1'/u.test(line)
}

check('the rescue profile still drops every session-control variable it must',
  ['DSH_TUI_RESUME_SESSION', 'DSH_TUI_RESUME_BACKEND', 'DSH_TUI_WORKSPACE_TARGET']
    .every(name => rescueDropped(launcher).includes(name)) && rescueDropped(launcher).length === 3,
  rescueDropped(launcher))
check('a bare request the launcher cannot derive is refused with exit code 1, not handed to --continue',
  refusesBareRequest(launcher) && bareRequestBlock(launcher).includes("args.unshift('--continue')"))
check('the retry marker is one string across the launcher and the host',
  retryEnvMarker(launcher) === RESUME_RETRY_ENV, { launcher: retryEnvMarker(launcher), host: RESUME_RETRY_ENV })
check('every safe-mode retry env carries the marker (all three branches feed one wrapper)',
  retryEnvAddsMarker(launcher))
const refusalEntry = /resumeNoLastSession: \{([\s\S]*?)\n  \},/u.exec(launcher)
check('the refusal message is bilingual in the launcher table',
  refusalEntry !== null && /\ben:/u.test(refusalEntry[1]!) && /\bzh:/u.test(refusalEntry[1]!))

// Bad baseline: the launcher checks above must be able to go red, or they are
// decoration. Each mutation is the shape a regression would actually take.
const mutations: readonly (readonly [string, string, string, (source: string) => boolean])[] = [
  ['the bare-request refusal stops failing the process', 'process.exit(1)\n    }\n    args.unshift', 'process.exit(0)\n    }\n    args.unshift', refusesBareRequest],
  ['the refusal goes back to injecting --continue', "console.error(msg('resumeNoLastSession')(bareWithoutTarget))", '', refusesBareRequest],
  ['the rescue profile stops dropping the resume mark', "'DSH_TUI_RESUME_BACKEND', ", '', source => rescueDropped(source).includes('DSH_TUI_RESUME_BACKEND')],
  ['the retry env loses its marker', "[RESUME_RETRY_ENV]: '1'", '[RESUME_RETRY_ENV]: true', retryEnvAddsMarker],
]
for (const [label, from, to, predicate] of mutations) {
  assert.ok(launcher.includes(from), `bad baseline: ${label} has a target to mutate`)
  const mutated = launcher.replace(from, to)
  assert.ok(mutated !== launcher, `bad baseline: ${label} really mutates the source`)
  check(`bad baseline goes red — ${label}`, predicate(mutated) === false)
}
check('the control stays green after every mutation was reverted (sources untouched)',
  readFileSync(fileURLToPath(new URL('../bin/dsh-tui.js', import.meta.url)), 'utf8') === launcher)

// ── The replacement process never inherits a one-shot handoff ─────────────────
const parentEnv = {
  PATH: '/usr/bin',
  [RESUME_BACKEND_ENV]: 'codex',
  [RESUME_RETRY_ENV]: '1',
  DSH_TUI_RESUME_SESSION: 'codex-1',
} as NodeJS.ProcessEnv
const replacement = restartChildEnv(parentEnv, 'codex-1', 'restart', {})
check('/restart drops the resume provenance and the retry licence, keeps the session and the rest',
  replacement[RESUME_BACKEND_ENV] === undefined && replacement[RESUME_RETRY_ENV] === undefined
    && replacement.DSH_TUI_RESUME_SESSION === 'codex-1' && replacement.PATH === '/usr/bin')
check('a kernel switch drops the session too (nothing survives for the next backend)',
  restartChildEnv(parentEnv, 'codex-1', 'restart', { backend: 'dsh' }).DSH_TUI_RESUME_SESSION === undefined)

console.log(`\nverify-resume-target OK (${passed} checks)`)
