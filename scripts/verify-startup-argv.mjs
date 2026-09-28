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
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

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
    session: null, workspace: null, submitted: [],
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
  const ctx = { provide(name, value) { this[name] = value } }
  provideCmdline(ctx, { args: program.args, exit: code => process.exit(code) })
  if (process.env.DSH_TUI_ARGV_SHAPE === 'args') ctx.cmdlineArgs = { args: program.args }

  const { initialPromptFromCmdlineArgs } = await import('../lib/types/dsh-adapter/plugin.js')
  const { resumeTargetFromArgv } = await import('../lib/types/sessionHistory.js')
  const { default: ts } = await import('typescript')
  const code = readFileSync(join(root, 'lib/types/dsh-adapter/plugin.js'), 'utf8')
  const source = ts.createSourceFile('plugin.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const apply = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'apply')
  assert.ok(apply?.body, 'compiled plugin apply exists')
  const declarations = new Map()
  for (const statement of apply.body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      declarations.set(declaration.name.getText(source), statement.getText(source))
    }
  }
  const names = ['cmdline', 'cmdlineArgs', 'requestedWorkspace', 'launchSessionId', 'submitChannel', 'initialPrompt']
  const startup = names.map(name => {
    assert.ok(declarations.has(name), `compiled startup declaration: ${name}`)
    return declarations.get(name)
  })
  const submit = apply.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(source) === 'initialPrompt')
  assert.ok(submit, 'compiled initial prompt submission branch exists')
  const submitted = []
  const scope = {
    ctx, process, initialPromptFromCmdlineArgs, resumeTargetFromArgv,
    config: {
      sessionId: process.env.DSH_TUI_RESUME_SESSION,
      workspace: process.env.DSH_TUI_WORKSPACE_TARGET,
    },
    shadow: false,
    channel: { submit: text => submitted.push(text) },
  }
  runInNewContext([
    ...startup, submit.getText(source),
    'globalThis.targets = { session: launchSessionId ?? null, workspace: requestedWorkspace ?? null }',
  ].join('\n'), scope)
  report('profile', { ...scope.targets, submitted })
  process.exit(0)
}

const temp = mkdtempSync(join(tmpdir(), 'dsh-tui-argv-'))
let failures = 0
let checks = 0
try {
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
    DSH_TUI_ARGV_PROBE: '1', NODE_OPTIONS: '--no-deprecation',
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
  ]
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
        const result = spawnSync(process.execPath, argv, {
          cwd: temp, encoding: 'utf8', timeout: 15000,
          env: { ...env, DSH_TUI_ARGV_SHAPE: shape, ...(route === 'bin' ? { DSH_TUI_NO_DELEGATE: '1' } : {}) },
        })
        const label = `${route}/${shape}: ${test.name}`
        checks += 1
        try {
          assert.equal(result.error, undefined)
          assert.equal(result.status, test.exitCode ?? 0, result.stderr)
          assert.deepEqual(JSON.parse(result.stdout), {
            mode: test.mode ?? 'profile',
            hostOptions: { patches: test.patches ?? [], fromDefaultProfile: test.fromDefaultProfile ?? null },
            session: test.session ?? null,
            workspace: test.workspace ?? null,
            submitted: test.prompt ? [test.prompt] : [],
            resumeEnv: direct ? null : test.session ?? null,
            workspaceEnv: test.workspace ?? null,
          })
          console.log(`PASS: ${label}`)
        } catch (error) {
          failures += 1
          console.error(`FAIL: ${label}\n${error.message}`)
        }
      }
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
console.log(`verify-startup-argv: ${checks - failures}/${checks} passed`)
if (failures > 0) process.exit(1)
