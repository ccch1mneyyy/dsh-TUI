// verify-liangshen-bash — custom-bash.mjs Git Bash discovery: candidate order,
// explicit-only override, Scoop shim following, WSL launcher rejection, and
// the register/skip behavior of apply() on a miss.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  bashCandidatesFromGit,
  isWindowsSubsystemLauncher,
  resolveShimTarget,
  resolveWindowsBash,
  windowsBashCandidates,
} from '../presets/liangshen/custom-bash.mjs'

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local',
  SCOOP: 'D:\\scoop',
  USERPROFILE: 'C:\\Users\\t',
}

// A subprocess double: resolveExecutable answers from a lowercase path map,
// spawn records argv/cwd and reports a clean exit with fixed output.
function fakeSubprocess(existing = {}) {
  return {
    spawns: [],
    async resolveExecutable(candidate) {
      const hit = existing[candidate.toLowerCase()]
      if (hit === undefined) throw new Error(`not found: ${candidate}`)
      return hit
    },
    spawn(options) {
      this.spawns.push(options)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'ok' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  }
}

// Candidate enumeration: conventional roots, Scoop roots (SCOOP before the
// per-user default), bare `bash` last; an explicit path collapses the list.
assert.deepEqual(windowsBashCandidates({}, ENV), [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  'C:\\Users\\t\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
  'C:\\Users\\t\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe',
  'D:\\scoop\\apps\\git\\current\\bin\\bash.exe',
  'D:\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe',
  'C:\\Users\\t\\scoop\\apps\\git\\current\\bin\\bash.exe',
  'C:\\Users\\t\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe',
  'bash',
])
assert.deepEqual(
  windowsBashCandidates({ bashPath: 'D:\\Portable\\Git\\bin\\bash.exe' }, ENV),
  ['D:\\Portable\\Git\\bin\\bash.exe'],
)
assert.deepEqual(
  windowsBashCandidates({}, { ...ENV, DSH_TUI_LIANGSHEN_BASH_PATH: 'E:\\Git\\bin\\bash.exe' }),
  ['E:\\Git\\bin\\bash.exe'],
)

// The System32/Sysnative bash.exe is the WSL launcher and must be rejected
// regardless of case.
assert.equal(isWindowsSubsystemLauncher('C:\\Windows\\System32\\bash.exe'), true)
assert.equal(isWindowsSubsystemLauncher('C:\\Windows\\Sysnative\\bash.exe'), true)
assert.equal(isWindowsSubsystemLauncher('C:\\WINDOWS\\SYSTEM32\\BASH.EXE'), true)
assert.equal(isWindowsSubsystemLauncher('C:\\Program Files\\Git\\bin\\bash.exe'), false)
assert.equal(isWindowsSubsystemLauncher('/c/Windows/System32/bash.exe'), true)

// git.exe layouts: <root>\cmd, <root>\bin strip to <root>; <root>\mingw64\bin
// also strips to <root> (the naive parent of the first rule is kept as a
// harmless extra root that simply fails resolution).
assert.deepEqual(bashCandidatesFromGit('C:\\Program Files\\Git\\cmd\\git.exe'), [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
])
assert.deepEqual(bashCandidatesFromGit('C:\\Git\\bin\\git.exe'), [
  'C:\\Git\\bin\\bash.exe',
  'C:\\Git\\usr\\bin\\bash.exe',
])
assert.deepEqual(bashCandidatesFromGit('C:\\Git\\mingw64\\bin\\git.exe'), [
  'C:\\Git\\mingw64\\bin\\bash.exe',
  'C:\\Git\\mingw64\\usr\\bin\\bash.exe',
  'C:\\Git\\bin\\bash.exe',
  'C:\\Git\\usr\\bin\\bash.exe',
])
assert.deepEqual(bashCandidatesFromGit('C:\\Git\\cmd\\git.exe'), [
  'C:\\Git\\bin\\bash.exe',
  'C:\\Git\\usr\\bin\\bash.exe',
])
assert.deepEqual(bashCandidatesFromGit(''), [])
assert.deepEqual(bashCandidatesFromGit('C:\\tools\\gitk.exe'), [])

// A real on-disk Scoop-style shim pair drives the sidecar resolution the
// PATH-following strategy depends on; plain executables pass through.
const temporary = mkdtempSync(join(tmpdir(), 'liangshen-bash-'))
try {
  const shimDir = join(temporary, 'shims')
  mkdirSync(shimDir)
  const gitShim = join(shimDir, 'git.exe')
  writeFileSync(gitShim, '')
  writeFileSync(join(shimDir, 'git.shim'), 'path = "C:\\Users\\t\\scoop\\apps\\git\\current\\cmd\\git.exe"\n')
  assert.equal(resolveShimTarget(gitShim), 'C:\\Users\\t\\scoop\\apps\\git\\current\\cmd\\git.exe')
  assert.equal(resolveShimTarget(join(temporary, 'plain.exe')), join(temporary, 'plain.exe'))

  // Resolution: a PATH git.exe is followed through its shim to the install
  // tree, and the tree's usr\bin candidate wins when bin is absent.
  const viaGit = fakeSubprocess({
    git: gitShim,
    'c:\\users\\t\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe': 'C:\\Users\\t\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe',
  })
  assert.equal(
    await resolveWindowsBash(viaGit, {}, ENV),
    'C:\\Users\\t\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe',
  )

  // A conventional-root hit wins before bare `bash` is even consulted.
  const viaConventional = fakeSubprocess({
    'c:\\program files\\git\\usr\\bin\\bash.exe': 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    bash: 'C:\\Windows\\System32\\bash.exe',
  })
  assert.equal(
    await resolveWindowsBash(viaConventional, {}, ENV),
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  )

  // A bare `bash` that resolves to the WSL launcher is rejected, and a Scoop
  // root later in the order still satisfies the lookup.
  const viaScoop = fakeSubprocess({
    'c:\\users\\t\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe': 'C:\\Users\\t\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe',
    bash: 'C:\\Windows\\System32\\bash.exe',
  })
  assert.equal(
    await resolveWindowsBash(viaScoop, {}, ENV),
    'C:\\Users\\t\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe',
  )

  // WSL launcher as the ONLY hit: resolution fails with every reason listed.
  await assert.rejects(
    resolveWindowsBash(fakeSubprocess({ bash: 'C:\\Windows\\System32\\bash.exe' }), {}, ENV),
    /Windows Subsystem for Linux launcher/,
  )

  // An explicit path is the only candidate: its miss fails without trying
  // conventional roots (no silent substitution), and config beats the env var.
  await assert.rejects(
    resolveWindowsBash(fakeSubprocess({}), { bashPath: 'D:\\missing\\bash.exe' }, ENV),
    /D:\\missing\\bash\.exe: not found/,
  )
  await assert.rejects(
    resolveWindowsBash(fakeSubprocess({}), {}, { ...ENV, DSH_TUI_LIANGSHEN_BASH_PATH: 'E:\\missing\\bash.exe' }),
    /E:\\missing\\bash\.exe: not found/,
  )
  assert.equal(
    await resolveWindowsBash(
      fakeSubprocess({ 'd:\\config\\bash.exe': 'D:\\config\\bash.exe', 'e:\\env\\bash.exe': 'E:\\env\\bash.exe' }),
      { bashPath: 'D:\\config\\bash.exe' },
      { ...ENV, DSH_TUI_LIANGSHEN_BASH_PATH: 'E:\\env\\bash.exe' },
    ),
    'D:\\config\\bash.exe',
  )

  // apply(): a successful resolution registers `bash`, and execute spawns the
  // RESOLVED executable (not a re-lookup) in the session cwd.
  const conventional = windowsBashCandidates({}, process.env).filter(path => path !== 'bash')
  const hit = conventional[0] ?? 'bash'
  const subprocess = fakeSubprocess({ [hit.toLowerCase()]: 'C:\\Resolved\\Git\\bin\\bash.exe' })
  const registered = []
  await apply({
    subprocess,
    tools: { register: tool => registered.push(tool) },
    logger: { warn() { throw new Error('unexpected warn on a hit') } },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'bash')
  assert.equal(registered[0].timeoutMs, 120000)
  const executed = await registered[0].execute(
    { command: 'echo hi' },
    { agent: { session: { header: { cwd: 'E:\\work' } } } },
  )
  assert.equal(executed.text, 'ok')
  assert.deepEqual(subprocess.spawns.at(-1).argv, ['C:\\Resolved\\Git\\bin\\bash.exe', '-c', 'echo hi'])
  assert.equal(subprocess.spawns.at(-1).cwd, 'E:\\work')

  // apply(): a total miss registers NOTHING and warns once — the absent `bash`
  // is what lets tool-bootstrap fail open to the full catalog.
  const missed = []
  const registeredOnMiss = []
  await apply({
    subprocess: fakeSubprocess({}),
    tools: { register: tool => registeredOnMiss.push(tool) },
    logger: { warn: message => missed.push(message) },
  })
  assert.equal(registeredOnMiss.length, 0)
  assert.match(missed.at(-1) ?? '', /Git Bash executable unavailable/)
  assert.match(missed.at(-1) ?? '', /full catalog/)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log('liangshen custom-bash verified (candidate order, explicit-only, shim following, WSL rejection, register/skip)')
