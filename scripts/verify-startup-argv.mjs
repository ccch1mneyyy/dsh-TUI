#!/usr/bin/env node
/**
 * Regression #882: full argv -> launcher -> app args -> targets + submission.
 * Run after build: node scripts/verify-startup-argv.mjs
 *
 * Runs the real bin (including its two-hop delegation) under an isolated HOME.
 * The downstream stub uses Commander's DSH option-prefix/pass-through grammar and
 * the real cmdline provider, then executes the compiled plugin's startup
 * selection/submission statements with a recording channel. This is a bounded
 * argv integration check, not a full Cordis/TTY/model-session boot.
 *
 * The compiled startup statements are pulled out of lib/types/dsh-adapter/
 * plugin.js once, here, and handed to every probe through a file, and the
 * probe imports the parsers, registry and generic backend startup without
 * mounting the plugin runtime. A fake backend replaces the native process;
 * every case still goes through the real bin and its delegation.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const bin = join(root, 'bin/dsh-tui.js')
const self = fileURLToPath(import.meta.url)
const probeMode = process.env.DSH_TUI_ARGV_PROBE === '1'

if (probeMode) {
  if (process.argv[2] === '--version') {
    console.log('dsh argv fixture')
    process.exit(0)
  }
  const fromWeb = createRequire(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const { Command } = fromWeb('commander')
  const { provideCmdline } = fromWeb('@deepseek-ai/dsh-cmdline')
  // Mirror the host options in DSH apps/cli/src/args.ts, not just --profile:
  // diagnostics and patch paths must be consumed before the app is mounted.
  const program = new Command()
    .exitOverride().helpOption(false).allowUnknownOption().passThroughOptions().enablePositionalOptions()
    .option('--profile <name>')
    .option('--from-default-profile <name>')
    .option('--patch <path>', 'extra overlay', (value, previous = []) => [...previous, value])
    .option('--dump-config').option('--dump-default-config').option('--dump-config-schema')
    .argument('[args...]')
  const report = (mode, app = {}) => console.log(JSON.stringify({
    mode,
    hostOptions: {
      patches: program.opts().patch ?? [],
      fromDefaultProfile: program.opts().fromDefaultProfile ?? null,
    },
    backend: null, session: null, workspace: null, submitted: [],
    resumeEnv: process.env.DSH_TUI_RESUME_SESSION ?? null,
    workspaceEnv: process.env.DSH_TUI_WORKSPACE_TARGET ?? null,
    ...app,
  }))
  try {
    program.parse(process.argv.slice(2), { from: 'user' })
  } catch (error) {
    if (!error.code?.startsWith('commander.')) throw error
    report('usage-error')
    process.exit(error.exitCode)
  }
  assert.equal(program.opts().profile, 'dsh-tui')
  const options = program.opts()
  const patches = options.patch ?? []
  const dumps = [
    ['dump-config', options.dumpConfig], ['dump-default-config', options.dumpDefaultConfig],
    ['dump-config-schema', options.dumpConfigSchema],
  ].filter(([, enabled]) => enabled).map(([mode]) => mode)
  if (patches.includes('') || options.fromDefaultProfile === '' || dumps.length > 1
    || (dumps.length > 0 && program.args.length > 0)
    || (options.dumpDefaultConfig && patches.length > 0)) {
    report('usage-error')
    process.exit(1)
  }
  // Stand in for the host's patch-file loading failure, before any app work.
  if (patches.some(path => !existsSync(path))) {
    report('patch-error')
    process.exit(1)
  }
  if (dumps.length > 0) {
    report(dumps[0])
    process.exit(0)
  }
  const warnings = []
  const ctx = {
    provide(name, value) { this[name] = value },
    // The boot reports a tolerated refusal through the Cordis logger; the real
    // one writes to stderr, which the report channel already owns here.
    logger: { warn: line => warnings.push(String(line)), error: line => warnings.push(String(line)) },
  }
  provideCmdline(ctx, { args: program.args, exit: code => process.exit(code) })
  if (process.env.DSH_TUI_ARGV_SHAPE === 'args') ctx.cmdlineArgs = { args: program.args }

  const { cmdlineArgsOf, initialPromptFromCmdlineArgs } = await import('../lib/types/dsh-adapter/startup-args.js')
  const { resumeTargetFromArgv, stripResumeArgs } = await import('../lib/types/sessionHistory.js')
  const { DSH_BACKEND_ID, KERNEL_SWITCH_HANDOFF_ENV, RESUME_BACKEND_ENV, RESUME_RETRY_ENV, parseBackendId, readKernelPrefs, resolveRememberedBackend, resolveResumeTarget } = await import('../lib/types/kernelPrefs.js')
  const { backendLabel, isBackendIdSyntax, isRegisteredBackend, listBackends, parseBackendChoice } = await import('../lib/types/dsh-adapter/backend-registry.js')
  const { setLang, t } = await import('../lib/types/i18n.js')
  // Deterministic refusal text: the boot itself sets the language from config,
  // which is not part of the extracted startup statements.
  setLang('en')
  const { startup, backendInput, resolution, target, submit } = JSON.parse(readFileSync(process.env.DSH_TUI_ARGV_STARTUP, 'utf8'))
  const submitted = []
  const scope = {
    ctx, process, cmdlineArgsOf, initialPromptFromCmdlineArgs, resumeTargetFromArgv, stripResumeArgs,
    // A replacement process skips the prompt (src/update.ts restartChildEnv).
    LAUNCH_PROMPT_SENT_ENV: 'DSH_TUI_LAUNCH_PROMPT_SENT',
    KERNEL_SWITCH_HANDOFF_ENV, RESUME_BACKEND_ENV, RESUME_RETRY_ENV, parseBackendId, readKernelPrefs,
    resolveRememberedBackend, resolveResumeTarget, backendLabel, isBackendIdSyntax,
    isRegisteredBackend, listBackends, parseBackendChoice, t,
    DSH_BACKEND_ID,
    // These cases pin the `dsh --profile` path, so `apply` gets no entry kernel route.
    dshInEntry: false,
    runtimeOptions: {},
    config: {
      backend: process.env.DSH_TUI_BACKEND,
      sessionId: process.env.DSH_TUI_RESUME_SESSION,
      workspace: process.env.DSH_TUI_WORKSPACE_TARGET,
      ...JSON.parse(process.env.DSH_TUI_ARGV_CONFIG ?? '{}'),
    },
    sessionCwd: process.cwd(),
    shadow: false,
    backendStart: undefined,
    // The profile path opens the session before the mount: ready at once.
    channel: { ready: true, submit: text => submitted.push(text) },
  }
  const context = createContext(scope)
  let refusal
  try {
    runInContext([
      ...startup,
      `globalThis.backendInput = { backend: backendChoice, input: ${backendInput} }`,
    ].join('\n'), context)
  } catch (error) {
    refusal = error
  }
  if (refusal !== undefined) {
    // Errors thrown inside the vm belong to the vm's realm, so `instanceof Error`
    // is false here — read the message off the shape instead.
    const message = typeof refusal?.message === 'string' ? refusal.message : String(refusal)
    // The startup statements threw, exactly like the boot's own refusal (roadmap
    // §6 item 11 / B-2a: a resume request that cannot be honored fails the boot
    // instead of degrading). Nothing was opened, resumed or created. Any other
    // throw is a fixture bug, reported as itself instead of as a refusal.
    if (!message.startsWith('Cannot resume')) {
      console.error(`PROBE ERROR: ${message}\n${refusal?.stack ?? ''}`)
      report('probe-error', { message })
      process.exit(1)
    }
    report('resume-refused', { message, warnings })
    process.exit(1)
  }
  if (scope.backendInput.backend !== 'dsh') {
    // Replace only the native process boundary. The real startup adapter reads
    // this backend's marker and chooses create/resume against the real ledger.
    const { openBackendStartup } = await import('../lib/types/dsh-adapter/backends.js')
    const backendId = scope.backendInput.backend
    const backend = {
      id: backendId,
      descriptor: { label: 'Argv fixture' },
      launch: {
        sessionPrefs: () => ({
          lastSession: () => {
            try {
              return JSON.parse(readFileSync(join(process.env.HOME, '.dsh-tui/backends', backendId, 'prefs.json'), 'utf8')).lastSession
            } catch {
              return undefined
            }
          },
          setLastSession: () => undefined,
          touch: () => undefined,
        }),
        resumeCommand: id => `fixture --resume ${id}`,
      },
      open: async target => ({
        ref: { backendId, sessionId: target.kind === 'resume' ? target.sessionId : 'created-session' },
        history: async () => [],
        dispose: async () => undefined,
      }),
    }
    scope.backendStart = await openBackendStartup(ctx, backend, scope.backendInput.input)
  }
  runInContext([
    ...resolution, submit,
    `globalThis.targets = { backend: backendChoice, session: ${target} ?? null, workspace: requestedWorkspace ?? null }`,
  ].join('\n'), context)
  report('profile', { ...scope.targets, submitted, ...(warnings.length > 0 ? { warnings } : {}) })
  process.exit(0)
}

/** The compiled plugin's startup declarations and submission branch, as source text. */
async function compiledStartup() {
  const { default: ts } = await import('typescript')
  const code = readFileSync(join(root, 'lib/types/dsh-adapter/plugin.js'), 'utf8')
  const source = ts.createSourceFile('plugin.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const apply = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'apply')
  assert.ok(apply?.body, 'compiled plugin apply exists')
  const declarations = new Map()
  for (const statement of apply.body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      declarations.set(declaration.name.getText(source), statement)
    }
  }
  // In `apply` order: `entryKernel` (the route an entry hands in) is replayed
  // because `backendChoice` reads it first; the pinned scope leaves it unset.
  const names = [
    'cmdlineArgs', 'requestedWorkspace', 'launchSessionId', 'submitChannel', 'initialPrompt',
    'rawBackend', 'handoffBackendRaw', 'handoffBackend', 'rememberedBackend', 'configuredBackend', 'entryKernel', 'backendChoice',
    'rawBackendGiven', 'resumeBackendRaw', 'resumeRetry', 'resumeTarget', 'effectiveSessionId', 'configuredSessionId', 'startupArgv',
  ]
  // The two refusal branches (a revoked target, and a resume request aimed at a
  // backend this host does not have) run for real: they are top-level statements
  // of the boot, so the probe evaluates whatever plugin.ts has — interleaved with
  // the declarations in source order — and a throw ends the process the way the
  // boot's startup funnel does.
  const refusals = apply.body.statements.filter(node => ts.isIfStatement(node)
    && /resumeTarget|rawBackendGiven/u.test(node.expression.getText(source)))
  assert.ok(refusals.length >= 2, 'compiled resume refusal branches exist')
  const startup = [
    ...names.map(name => {
      assert.ok(declarations.has(name), `compiled startup declaration: ${name}`)
      return declarations.get(name)
    }),
    ...refusals,
  ].sort((a, b) => a.getStart(source) - b.getStart(source)).map(node => node.getText(source))
  const submit = apply.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(source) === 'initialPrompt')
  assert.ok(submit, 'compiled initial prompt submission branch exists')
  let target
  /**
   * Only top-level `resolveAgent` calls in `apply`: the DSH-in-entry path
   * (`attachDsh`) has its own nested resume target that must not be taken.
   */
  const isNestedFunction = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
  let backendInput
  /** Block-local declarations, for an input passed by name. */
  const locals = new Map()
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      locals.set(node.name.text, node.initializer.getText(source))
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'openBackendStartup') {
      const input = node.arguments[2]
      backendInput = ts.isIdentifier(input) ? locals.get(input.text) : input.getText(source)
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'resolveAgent') {
      assert.ok(ts.isIdentifier(node.arguments[1]), 'DSH startup consumes a named resume target')
      target = node.arguments[1].text
    }
    ts.forEachChild(node, child => {
      if (!isNestedFunction(child)) visit(child)
    })
  }
  visit(apply.body)
  assert.ok(target && declarations.has(target), 'compiled resume target passed to resolveAgent exists')
  assert.ok(backendInput, 'compiled input passed to openBackendStartup exists')
  const resolution = names.includes(target) ? [] : [declarations.get(target).getText(source)]
  return { startup, backendInput, resolution, target, submit: submit.getText(source) }
}

/** spawnSync's result shape, without blocking the other cases. */
function run(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', error => resolve({ error, status: null, stdout, stderr }))
    child.on('close', (status, signal) => resolve({
      error: signal ? new Error(`killed by ${signal}`) : undefined, status, stdout, stderr,
    }))
  })
}

const temp = mkdtempSync(join(tmpdir(), 'dsh-tui-argv-'))
let failures = 0
let checks = 0
try {
  const startupFile = join(temp, 'compiled-startup.json')
  writeFileSync(startupFile, JSON.stringify(await compiledStartup()))
  const stubDir = join(temp, 'bin')
  const dshHome = join(temp, '.dsh')
  const profilePackage = join(dshHome, 'profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui')
  const workspace = join(temp, 'literal workspace')
  const patch = join(temp, 'overlay with spaces.yml')
  for (const dir of [stubDir, join(profilePackage, 'bin'), join(temp, '.dsh-tui'), workspace]) {
    mkdirSync(dir, { recursive: true })
  }
  const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(profilePackage, 'package.json'), JSON.stringify({ name, version, type: 'module' }))
  copyFileSync(bin, join(profilePackage, 'bin/dsh-tui.js'))
  writeFileSync(join(temp, '.dsh-tui/resume.txt'), 'remembered-session')
  // The Claude backend's own last-session marker (never resume.txt).
  mkdirSync(join(temp, '.dsh-tui/backends/claude'), { recursive: true })
  writeFileSync(join(temp, '.dsh-tui/backends/claude/prefs.json'), JSON.stringify({ lastSession: 'claude-last' }))
  mkdirSync(join(temp, '.dsh-tui/backends/missing-agent'), { recursive: true })
  writeFileSync(join(temp, '.dsh-tui/backends/missing-agent/prefs.json'), JSON.stringify({ lastSession: 'foreign-session' }))
  writeFileSync(patch, '[]\n')
  writeFileSync(join(temp, '--resume=patch-file'), '[]\n')
  const isWin = process.platform === 'win32'
  const quoteSh = value => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(join(stubDir, 'dsh'), `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(self)} "$@"\n`, { mode: 0o755 })
  if (isWin) {
    writeFileSync(join(stubDir, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${self}" %*\r\n@exit /b %errorlevel%\r\n`)
  }
  const env = {
    PATH: [stubDir, dirname(process.execPath), ...(isWin ? ['C:\\Windows\\System32', 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(delimiter),
    ...(isWin ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    HOME: temp, USERPROFILE: temp, DSH_HOME: dshHome,
    DSH_TUI_ARGV_PROBE: '1', DSH_TUI_ARGV_STARTUP: startupFile, NODE_OPTIONS: '--no-deprecation',
    // A Claude launch would go to the entry; routing is off to keep these on `dsh --profile`.
    DSH_TUI_HOST_ENTRY: '0',
  }
  const cases = [
    ...[
      ['--resume=sid-1'], ['--resume', 'sid-1'], ['-c'], ['--continue'],
      ['.'], [workspace], ['ssh://sandbox/workspace'],
      ['--host', 'example'], ['--profile', 'not-the-profile'], ['--', '--resume=sid-1'],
    ].map(literal => ({ name: `literal ${literal.join(' ')}`, argv: ['--', ...literal], prompt: literal.join(' ') })),
    { name: 'prefix prompt', argv: ['explain', '--', '--resume=sid-1'], prompt: 'explain --resume=sid-1' },
    { name: 'explicit resume before separator', argv: ['--resume', 'real-session', '--', '--resume=literal'], session: 'real-session', prompt: '--resume=literal' },
    { name: 'bare resume before separator', argv: ['--resume', '--', '--continue'], session: 'remembered-session', prompt: '--continue' },
    { name: 'continue before separator', argv: ['-c', '--', '--resume=literal'], session: 'remembered-session', prompt: '--resume=literal' },
    { name: 'long continue before separator', argv: ['--continue', '--', '--resume=literal'], session: 'remembered-session', prompt: '--resume=literal' },
    { name: 'ordinary resume', argv: ['--resume=real-session'], session: 'real-session', prompt: '' },
    { name: 'Web startup flags', argv: ['--host', '127.0.0.1', '--port', '3099', '--trusted-host', 'a:1', 'b:2'], prompt: '' },
    { name: 'separator only', argv: ['--'], prompt: '' },
    { name: 'explicit workspace before separator', argv: [workspace, '--', '--resume=literal', '.'], workspace, prompt: '--resume=literal .', binOnly: true },
    // Host-prefix cases need only the current service shape; both shapes are
    // already covered above for app-level option parsing and submission.
    { name: 'DSH dump config', hostArgs: ['--dump-config'], argv: [], mode: 'dump-config' },
    { name: 'DSH dump defaults', hostArgs: ['--dump-default-config'], argv: [], mode: 'dump-default-config' },
    { name: 'DSH dump schema', hostArgs: ['--dump-config-schema'], argv: [], mode: 'dump-config-schema' },
    { name: 'DSH diagnostics reject literal app input', hostArgs: ['--dump-config'], argv: ['--', '--resume=literal'], mode: 'usage-error', exitCode: 1 },
    { name: 'DSH patch and diagnostics', hostArgs: ['--patch', patch, '--dump-config'], argv: [], patches: [patch], mode: 'dump-config' },
    { name: 'DSH patch and literal prompt', hostArgs: ['--patch', patch], argv: ['--', '--resume=literal', './notes'], patches: [patch], prompt: '--resume=literal ./notes' },
    { name: 'DSH patch and positional prompt', hostArgs: ['--patch', patch], argv: ['explain', 'flags'], patches: [patch], prompt: 'explain flags' },
    { name: 'DSH repeated and inline patches', hostArgs: [`--patch=${patch}`, '--patch', patch], argv: ['--', '--patch', 'literal.yml'], patches: [patch, patch], prompt: '--patch literal.yml' },
    { name: 'DSH patch value is not a resume flag', hostArgs: ['--patch', '--resume=patch-file'], argv: ['--', '--continue'], patches: ['--resume=patch-file'], prompt: '--continue' },
    { name: 'DSH missing patch is not prompt text', hostArgs: ['--patch', 'missing.yml'], argv: [], patches: ['missing.yml'], mode: 'patch-error', exitCode: 1 },
    { name: 'DSH missing patch prevents literal submission', hostArgs: ['--patch', 'missing.yml'], argv: ['--', '--resume=literal'], patches: ['missing.yml'], mode: 'patch-error', exitCode: 1 },
    { name: 'DSH missing patch value stays a usage error', hostArgs: ['--patch'], argv: [], mode: 'usage-error', exitCode: 1 },
    { name: 'DSH empty inline patch stays a usage error', hostArgs: ['--patch='], argv: [], patches: [''], mode: 'usage-error', exitCode: 1 },
    { name: 'DSH template prefix and literal prompt', hostArgs: ['--from-default-profile=web'], argv: ['--', '--dump-config'], fromDefaultProfile: 'web', prompt: '--dump-config' },
    { name: 'literal host flags do not become host options', hostArgs: [], argv: ['--', '--dump-config', '--patch', 'missing.yml'], prompt: '--dump-config --patch missing.yml' },
    { name: 'host prefix ends at an app flag', hostArgs: [], argv: ['--fullscreen', '--dump-config'], prompt: '' },
    { name: 'host prefix ends at a positional', hostArgs: [], argv: ['explain', '--dump-config'], prompt: 'explain' },
    { name: 'DSH prefix survives TUI resume interception', hostArgs: [], argv: ['--resume', 'real-session', '--patch', patch, '--', '--resume=literal'], patches: [patch], session: 'real-session', prompt: '--resume=literal', binOnly: true },
    { name: 'DSH prefix survives workspace interception', hostArgs: [], argv: [workspace, '--patch', patch, '--', '--resume=literal'], patches: [patch], workspace, prompt: '--resume=literal', binOnly: true },
    // Phase 4b: a bare --resume of the Claude backend reopens ITS last session
    // (the backend may be named after the flag); explicit ids and DSH's
    // "each flag sets it, the last wins" are unchanged.
    { name: 'Claude bare resume reads the Claude marker', hostArgs: [], argv: ['--backend', 'claude', '--resume'], backend: 'claude', session: 'claude-last', prompt: '', binOnly: true },
    { name: 'Claude bare resume before --backend', hostArgs: [], argv: ['--resume', '--backend', 'claude'], backend: 'claude', session: 'claude-last', prompt: '', binOnly: true },
    { name: 'Claude explicit resume', hostArgs: [], argv: ['--backend', 'claude', '--resume', 'claude-explicit'], backend: 'claude', session: 'claude-explicit', prompt: '', binOnly: true },
    { name: 'DSH bare resume after an explicit one (last wins)', hostArgs: [], argv: ['--resume', 'explicit-first', '--resume'], session: 'remembered-session', prompt: '', binOnly: true },
    // B-2a: a resume request that cannot be honored is refused with a non-zero
    // exit instead of degrading into a cold start, a foreign session, or a new
    // one. Three shapes: the launcher cannot derive a target for a bare request
    // (`launcherError`), the boot revokes a derived target (`refusal`), and the
    // boot refuses a resume aimed at a backend this host does not have
    // (`refusal`, the id it would have resumed named in the message). A revoked
    // target's advice has to be executable (PR #1449 review R2): an unregistered
    // source backend gets the "install it first" sentence instead of a
    // `--backend <from> --resume` that would hit this same refusal, while a
    // registered one names both ways back — by id, never by display label.
    { name: 'unknown env with no preference: bare resume is refused, not silently DSH', argv: ['--resume'], envBackend: 'claud', launcherError: 'claud', prompt: '', binOnly: true },
    { name: 'unknown env with a foreign preference: the foreign marker is refused on dsh, with no dead-end advice', argv: ['--resume'], envBackend: 'missing-agent', refusal: '"missing-agent" backend, which is not installed', prompt: '', binOnly: true },
    { name: 'unknown flag: a bare resume it cannot derive is refused before literal input', argv: ['--backend', 'claud', '--resume', '--', '--resume=literal'], launcherError: 'claud', prompt: '--resume=literal', binOnly: true },
    { name: 'bare resume does not consume the following prompt, and is refused', argv: ['--resume', '--backend', 'claud', 'explain'], launcherError: 'claud', prompt: 'explain', binOnly: true },
    { name: 'an explicit final resume wins over a preceding bare one, and is refused on the missing backend', argv: ['--backend', 'missing-agent', '--resume', '--resume', 'explicit-last'], refusal: '"explicit-last"', prompt: '', binOnly: true },
    { name: 'a bare resume derived from the DSH marker is refused when the remembered kernel is Claude, naming both ways back', argv: ['--resume'], memoryBackend: 'claude', refusal: '--backend dsh --resume.*--backend claude --resume', prompt: '', binOnly: true },
    { name: 'a backend with no resume history is refused, not turned into a fresh launch', argv: ['--backend', 'claude', '--resume'], noClaudeMarker: true, launcherError: 'claude', prompt: '', binOnly: true },
    // The safe-mode "retry normal startup" path is the one exception: its target
    // comes from last-run.json, and the recorded backend may be gone by now. That
    // retry is the user's last way back, so the refusal degrades to a warning plus
    // a cold start instead of ending the process (RESUME_RETRY_ENV, roadmap §6
    // item 11's fail-closed landing with the retry carve-out).
    {
      name: 'a safe-mode retry tolerates a target whose backend is gone and continues cold',
      argv: [],
      envExtra: { DSH_TUI_RESUME_SESSION: 'stale-1', DSH_TUI_RESUME_BACKEND: 'missing-agent', DSH_TUI_RESUME_RETRY: '1' },
      session: null, resumeEnv: 'stale-1', warns: '"missing-agent"', prompt: '', binOnly: true,
    },
    {
      name: 'a safe-mode retry drops replayed continue instead of resuming the DSH marker',
      argv: ['--continue', 'explain'], envBackend: 'missing-agent',
      envExtra: { DSH_TUI_RESUME_RETRY: '1' },
      session: null, resumeEnv: 'foreign-session', warns: '"missing-agent"', prompt: 'explain', binOnly: true,
    },
    {
      name: 'a safe-mode retry drops replayed continue instead of resuming the remembered Claude marker',
      argv: ['--continue', 'explain'], memoryBackend: 'claude', backend: 'claude',
      envExtra: { DSH_TUI_RESUME_RETRY: '1' },
      session: null, resumeEnv: 'remembered-session', warns: '"dsh"', prompt: 'explain', binOnly: true,
    },
    {
      name: 'an explicit DSH config resumes despite an overridden unavailable env backend',
      argv: ['--resume', 'dsh-explicit'], envBackend: 'missing-agent',
      config: { backend: 'dsh' }, session: 'dsh-explicit', prompt: '',
    },
    {
      name: 'an explicit Claude config resumes despite an overridden unavailable env backend',
      argv: ['--resume', 'claude-explicit'], envBackend: 'missing-agent',
      config: { backend: 'claude' }, backend: 'claude', session: 'claude-explicit', prompt: '',
    },
    {
      name: 'a valid handoff resumes despite an overridden unavailable env backend and DSH config',
      argv: ['--resume', 'claude-explicit'], envBackend: 'missing-agent', config: { backend: 'dsh' },
      envExtra: { DSH_TUI_BACKEND_HANDOFF: 'claude' },
      backend: 'claude', session: 'claude-explicit', prompt: '',
    },
  ]
  // stripResumeArgs: the ONE grammar that decides what a respawned process
  // must not inherit. A kernel switch respawns onto the other backend, where
  // this kernel's session id means nothing (update.ts restartTui); the
  // function shares its flag set with resumeTargetFromArgv above, so these
  // cases pin both the flags and the id they consume.
  const { stripResumeArgs } = await import('../lib/types/sessionHistory.js')
  const stripCases = [
    { name: 'explicit id', argv: ['--resume', 'sid'], want: [] },
    { name: 'inline id', argv: ['--resume=sid'], want: [] },
    { name: 'short continue', argv: ['-c'], want: [] },
    { name: 'long continue', argv: ['--continue'], want: [] },
    { name: 'bare flag eats the id behind it', argv: ['--resume', 'sid', '--fullscreen'], want: ['--fullscreen'] },
    { name: 'bare flag before another flag keeps it', argv: ['--resume', '--fullscreen'], want: ['--fullscreen'] },
    { name: 'separator ends option parsing', argv: ['--resume=sid', '--', '--resume=literal'], want: ['--', '--resume=literal'] },
    { name: 'unrelated flags survive in place', argv: ['--fullscreen', '--backend', 'claude'], want: ['--fullscreen', '--backend', 'claude'] },
  ]
  for (const test of stripCases) {
    checks += 1
    try {
      assert.deepEqual(stripResumeArgs(test.argv), test.want)
      console.log(`PASS: stripResumeArgs ${test.name}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL: stripResumeArgs ${test.name}\n${error.message}`)
    }
  }

  const runs = []
  for (const route of ['bin', 'delegated-bin', 'direct-profile']) {
    for (const shape of ['get', 'args']) {
      for (const test of cases) {
        if (test.binOnly && route === 'direct-profile') continue
        if (shape === 'args' && test.hostArgs !== undefined) continue
        const direct = route === 'direct-profile'
        // The explicit outer -- belongs to DSH, the inner one (in test.argv)
        // belongs to the app. Real options after just the outer -- must work.
        const hostArgs = test.hostArgs ?? []
        const argv = direct
          ? [self, '--profile', 'dsh-tui', ...hostArgs, ...(test.argv.length ? ['--', ...test.argv] : [])]
          : [bin, ...hostArgs, ...test.argv]
        // Native startup touches the ledger. Keep each probe's HOME independent,
        // while the immutable profile and workspace fixtures remain shared.
        const caseHome = join(temp, 'homes', String(runs.length))
        const casePrefs = join(caseHome, '.dsh-tui')
        mkdirSync(casePrefs, { recursive: true })
        copyFileSync(join(temp, '.dsh-tui/resume.txt'), join(casePrefs, 'resume.txt'))
        for (const backend of ['claude', 'missing-agent']) {
          if (backend === 'claude' && test.noClaudeMarker) continue
          mkdirSync(join(casePrefs, 'backends', backend), { recursive: true })
          copyFileSync(join(temp, '.dsh-tui/backends', backend, 'prefs.json'), join(casePrefs, 'backends', backend, 'prefs.json'))
        }
        if (test.memoryBackend !== undefined) writeFileSync(join(casePrefs, 'kernel.json'), JSON.stringify({ backend: test.memoryBackend }))
        runs.push({
          label: `${route}/${shape}: ${test.name}`, direct, test,
          start: () => run(process.execPath, argv, {
            cwd: temp, timeout: 15000,
            env: {
              ...env, DSH_TUI_ARGV_SHAPE: shape,
              HOME: caseHome, USERPROFILE: caseHome,
              ...(test.envBackend === undefined ? {} : { DSH_TUI_BACKEND: test.envBackend }),
              ...(test.config === undefined ? {} : { DSH_TUI_ARGV_CONFIG: JSON.stringify(test.config) }),
              ...test.envExtra,
              ...(route === 'bin' ? { DSH_TUI_NO_DELEGATE: '1' } : {}),
            },
          }),
        })
      }
    }
  }
  // Every case only reads the shared fixture tree, so they can run side by
  // side; results are still reported in case order.
  const queue = [...runs]
  await Promise.all(Array.from({ length: availableParallelism() }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) next.result = await next.start()
  }))
  for (const { label, direct, test, result } of runs) {
    checks += 1
    try {
      assert.equal(result.error, undefined)
      if (test.launcherError !== undefined || test.refusal !== undefined) {
        // Refusals are launcher- or boot-side, both before any session exists.
        assert.equal(result.status, 1, result.stderr)
        if (test.refusal !== undefined) {
          const report = JSON.parse(result.stdout)
          assert.equal(report.mode, 'resume-refused', JSON.stringify(report))
          assert.equal(report.backend, null)
          assert.equal(report.session, null)
          assert.equal(report.submitted.length, 0)
          assert.match(report.message, new RegExp(test.refusal, 'u'))
        } else {
          assert.equal(result.stdout, '')
          assert.match(result.stderr, new RegExp(test.launcherError, 'u'))
        }
        console.log(`PASS: ${label}`)
        continue
      }
      assert.equal(result.status, test.exitCode ?? 0, result.stderr)
      if (test.warns !== undefined) {
        const report = JSON.parse(result.stdout)
        assert.ok(report.warnings?.some(line => new RegExp(test.warns, 'u').test(line)), JSON.stringify(report.warnings))
      }
      assert.deepEqual(JSON.parse(result.stdout), {
        mode: test.mode ?? 'profile',
        hostOptions: { patches: test.patches ?? [], fromDefaultProfile: test.fromDefaultProfile ?? null },
        backend: test.mode === undefined ? test.backend ?? 'dsh' : null,
        session: test.session ?? null,
        workspace: test.workspace ?? null,
        submitted: test.prompt ? [test.prompt] : [],
        resumeEnv: direct ? null : test.resumeEnv === undefined ? test.session ?? null : test.resumeEnv,
        workspaceEnv: test.workspace ?? null,
        // Content asserted above; here only the field's presence is pinned.
        ...(test.warns === undefined ? {} : { warnings: JSON.parse(result.stdout).warnings }),
      })
      console.log(`PASS: ${label}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL: ${label}\n${error.message}`)
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
console.log(`verify-startup-argv: ${checks - failures}/${checks} passed`)
if (failures > 0) process.exit(1)
