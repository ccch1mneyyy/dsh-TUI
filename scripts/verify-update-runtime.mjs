/**
 * Headless updates must replace the private runtime before reporting success.
 * Real npm tarballs, loopback registry, pnpm, and official package operations;
 * the fixture CLI only forwards to runPluginCommand. No global DSH is required.
 * Transpiles the actual updater and host resolver, retaining the old store copy.
 * Run through pnpm, or set DSH_TUI_VERIFY_PNPM to its JavaScript CLI entry.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { commandInvocation } from './dev-command.mjs'
import { materializeRecipe, PACKAGE, RUNTIME_BUNDLE, runtimeStatus } from '../src/dsh-adapter/market/runtime-profile.mjs'

function fixtureInvocation(command, args, platform = process.platform) {
  const cmdSuffix = /\.cmd$/iu.test(command)
  const bareName = !/[\\/.]/u.test(command)
  if (platform !== 'win32' || (!cmdSuffix && !bareName)) return [command, args, false]
  // The shared helper appends .cmd and quotes a complete shell command.
  const [executable, invocation] = commandInvocation(cmdSuffix ? command.slice(0, -4) : command, args, platform)
  return [executable, invocation, true]
}

function verifyCommandRouting() {
  const args = ['--flag', String.raw`C:\work tree\中文 & input.mjs`]
  const node = String.raw`C:\Program Files\nodejs\node.exe`
  const pnpm = String.raw`C:\Package Tools\pnpm.cmd`
  assert.deepEqual(fixtureInvocation(node, args, 'win32'), [node, args, false], 'native executable paths bypass the shell')
  assert.deepEqual(fixtureInvocation('node.exe', args, 'win32'), ['node.exe', args, false])
  for (const command of ['npm', 'pnpm.cmd', pnpm]) {
    const [executable, invocation, shell] = fixtureInvocation(command, args, 'win32')
    assert.equal(shell, true, '.cmd launchers require the Windows shell')
    assert.deepEqual(invocation, [], 'the helper quotes arguments into the shell command')
    assert.match(executable, /\.cmd /u)
    assert.doesNotMatch(executable, /\.cmd\.cmd/u)
    assert.match(executable, /\^&/u)
    assert.doesNotMatch(executable, /work tree/u, 'spaces in shell arguments are escaped')
    if (command === pnpm) assert.ok(executable.startsWith(String.raw`C:\Package^ Tools\pnpm.cmd `))
  }
  for (const command of ['npm', '/opt/Node Tools/node', '/opt/Package Tools/pnpm.cmd']) {
    assert.deepEqual(fixtureInvocation(command, args, 'linux'), [command, args, false])
  }
  console.log('PASS: command routing assertions (Windows shell/native paths, Linux passthrough)')
}

if (process.argv[2] === '--update') {
  // Only the public mirror comparison is redirected; every fetch still reaches
  // the real local registry. The installer also uses that registry directly.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, options) => originalFetch(String(url).replace('https://registry.npmjs.org', process.env.npm_config_registry), options)
  const updater = await import(pathToFileURL(process.env.DSH_UPDATE_OLD_ENTRY).href)
  assert.equal(updater.installedTuiVersion(), process.env.DSH_UPDATE_RUNNING_VERSION, 'update loads the requested physical package')
  process.exitCode = await updater.cliUpdate('dsh-tui')
} else {
  verifyCommandRouting()
  await verify()
}

async function verify() {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-update-runtime-'))
  const packageRoot = profile => join(profile, 'node_modules', PACKAGE)
  const json = async file => JSON.parse(await readFile(file, 'utf8'))
  const configured = process.env.DSH_TUI_VERIFY_PNPM
    ?? (basename(process.env.npm_execpath ?? '').includes('pnpm') ? process.env.npm_execpath : undefined)
    ?? (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')).find(path => existsSync(path))
  assert.ok(configured, 'pnpm must be on PATH or supplied through DSH_TUI_VERIFY_PNPM')
  const pnpm = await realpath(configured)
  const pnpmCommand = /\.[cm]?js$/u.test(pnpm) ? process.execPath : pnpm
  const pnpmPrefix = pnpmCommand === process.execPath ? [pnpm] : []
  let server
  const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
    const [executable, invocation, shell] = fixtureInvocation(command, args)
    const child = spawn(executable, invocation, {
      cwd: scratch, encoding: 'utf8', shell,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, ...options,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolveRun({ code, signal, output }))
  })
  const successful = async (command, args, options) => {
    const result = await run(command, args, options)
    assert.equal(result.code, 0, result.output || `subprocess stopped: ${result.signal}`)
    return result.output
  }
  try {
    const sources = new Map()
    function collect(source) {
      if (sources.has(source)) return
      const code = ts.transpileModule(readFileSync(source, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }, fileName: source,
      }).outputText
      sources.set(source, code)
      for (const imported of ts.preProcessFile(code, true, true).importedFiles) {
        if (!imported.fileName.startsWith('.')) continue
        const base = resolve(dirname(source), imported.fileName.replace(/\.js$/, '.ts'))
        const dependency = existsSync(base) ? base : base.replace(/\.ts$/, '.tsx')
        assert.ok(existsSync(dependency), `source dependency: ${dependency}`)
        collect(dependency)
      }
    }
    collect(join(repo, 'src/update.ts'))
    collect(join(repo, 'src/dsh-adapter/host-dsh.ts'))
    const records = new Map()
    for (const version of ['1.0.0', '2.0.0']) {
      const root = join(scratch, `package-${version}`)
      const patch = `# prepared runtime ${version}\n[]\n`
      const manifest = {
        name: PACKAGE, version, type: 'module', main: './index.js',
        imports: {
          '#tui-market/prepare': './src/dsh-adapter/market/prepare.mjs',
          '#tui-market/runtime-profile': './src/dsh-adapter/market/runtime-profile.mjs',
        },
        dsh: { bundle: { patch: './market.patch.yml' } }, dshTui: { runtimeBundle: './lib/tui-runtime' },
        dependencies: {}, bundledDependencies: ['semver', 'chalk'],
      }
      for (const name of manifest.bundledDependencies) {
        const installed = await realpath(join(repo, 'node_modules', name))
        manifest.dependencies[name] = (await json(join(installed, 'package.json'))).version
        await cp(installed, join(root, 'node_modules', name), { recursive: true, dereference: true })
      }
      for (const [source, code] of sources) {
        const output = join(root, 'lib/types', relative(join(repo, 'src'), source).replace(/\.tsx?$/, '.js'))
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, code)
      }
      await mkdir(join(root, 'src/dsh-adapter/market'), { recursive: true })
      for (const name of ['prepare', 'runtime-profile']) await cp(join(repo, `src/dsh-adapter/market/${name}.mjs`), join(root, `src/dsh-adapter/market/${name}.mjs`))
      await mkdir(join(root, 'lib/tui-runtime'), { recursive: true })
      await mkdir(join(root, 'bin'), { recursive: true })
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
      for (const name of ['index.js', 'bin/dsh-tui.js', 'lib/types/dsh-adapter/host-entry.js']) await writeFile(join(root, name), 'export {}\n')
      await writeFile(join(root, 'market.patch.yml'), '[]\n')
      await writeFile(join(root, 'lib/tui-runtime/cordis.patch.yml'), patch)
      await writeFile(join(root, 'lib/tui-runtime/package.json'), JSON.stringify({
        name: RUNTIME_BUNDLE, version, dependencies: { [PACKAGE]: version },
        dsh: { bundle: { patch: './cordis.patch.yml' } }, dshTui: { patchSha256: createHash('sha256').update(patch).digest('hex') },
      }))
      await successful('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], { cwd: root })
      const tarball = await readFile(join(scratch, `deepseek-harness-tui-dsh-tui-${version}.tgz`))
      records.set(version, { manifest, tarball, integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` })
    }
    let registry
    server = createServer((req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0])
      const versions = Object.fromEntries([...records].map(([version, item]) => [version, {
        ...item.manifest, dist: { tarball: `${registry}/${version}.tgz`, integrity: item.integrity },
      }]))
      if (path === `/${PACKAGE}` || path === `/${PACKAGE}/latest`) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(path.endsWith('/latest') ? versions['2.0.0'] : {
          name: PACKAGE, 'dist-tags': { latest: '2.0.0' }, versions,
          time: { created: '2020-01-01T00:00:00Z', modified: '2020-01-01T00:00:00Z', '1.0.0': '2020-01-01T00:00:00Z', '2.0.0': '2020-01-01T00:00:00Z' },
        }))
      } else if (records.has(path.slice(1, -4))) res.end(records.get(path.slice(1, -4)).tarball)
      else { res.writeHead(404); res.end('fixture registry has no other packages') }
    })
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    registry = `http://127.0.0.1:${server.address().port}`
    const bin = join(scratch, 'bin')
    const host = join(bin, 'node_modules/@deepseek-ai/dsh')
    await mkdir(host, { recursive: true })
    await symlink(join(repo, 'node_modules'), join(host, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', type: 'module', bin: './bin.mjs' }))
    await writeFile(join(host, 'bin.mjs'), `#!/usr/bin/env node
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { fileURLToPath } from 'node:url'
const [command, flag, profile, ...args] = process.argv.slice(2)
if (command !== 'plugin' || flag !== '--profile') throw new Error('Unexpected fixture CLI invocation')
const result = await runPluginCommand({ profile, home: process.env.DSH_HOME, cwd: process.cwd(), installAnchor: fileURLToPath(new URL('package.json', import.meta.url)) }, args, {
  command: 'pnpm', execution: 'service', outputBytes: 16384, idleTimeoutMs: 20000,
  onOutput: (text, stream) => process[stream].write(text),
})
process.exitCode = result.exitCode
`)
    await writeFile(join(bin, 'pnpm.mjs'), `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { commandInvocation } from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/dev-command.mjs')).href)}
${fixtureInvocation.toString()}
const args = process.argv.slice(2)
const controlFile = join(process.cwd(), '.fixture-update.json')
if (existsSync(controlFile)) {
  const control = JSON.parse(readFileSync(controlFile, 'utf8'))
  const stat = statSync(join(process.cwd(), '.dsh-tui/setup.json.lock'), { bigint: true })
  const version = root => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  appendFileSync(control.trace, JSON.stringify({ args, lock: [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs].map(String), old: version(control.oldRoot), direct: version(join(process.cwd(), 'node_modules', ${JSON.stringify(PACKAGE)})) }) + '\\n')
  if (control.failPrepare && args[0] === 'add' && args.some(arg => arg.startsWith('file:'))) process.exit(37)
}
const [command, invocation, shell] = fixtureInvocation(${JSON.stringify(pnpmCommand)}, [...${JSON.stringify(pnpmPrefix)}, ...args, ${JSON.stringify(`--registry=${registry}`)}])
const child = spawn(command, invocation, { stdio: 'inherit', shell, timeout: 30000, env: { ...process.env, CI: '1', PNPM_MAX_WORKERS: '1', npm_config_update_notifier: 'false' } })
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
`)
    for (const [name, script] of [['dsh', join(host, 'bin.mjs')], ['pnpm', join(bin, 'pnpm.mjs')]]) {
      if (process.platform === 'win32') await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
      else { await chmod(script, 0o755); await symlink(script, join(bin, name)) }
    }
    for (const failPrepare of [false, true]) {
      const home = join(scratch, failPrepare ? 'failed-preparation' : 'successful-update')
      const profile = join(home, 'profiles/dsh-tui')
      const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, CI: '1', PNPM_MAX_WORKERS: '1', npm_config_update_notifier: 'false', NPM_CONFIG_REGISTRY: registry, npm_config_registry: registry }
      for (const key of ['DSH_TUI_STANDALONE', 'DSH_TUI_STANDALONE_BINARY', 'DSH_TUI_HOST_ENTRY_PATH', 'DSH_TUI_DISABLE_HOST_ENTRY']) delete env[key]
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: [] } } }))
      await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages: []\nminimumReleaseAge: 0\nautoInstallPeers: false\n')
      const cli = args => successful(process.execPath, [join(host, 'bin.mjs'), 'plugin', '--profile', 'dsh-tui', ...args], { env })
      await cli(['add', `${PACKAGE}@1.0.0`, '--save-exact'])
      const oldRoot = await realpath(packageRoot(profile))
      const recipe = await materializeRecipe(profile, packageRoot(profile))
      await cli(['add', `file:${recipe}`, '--save-exact'])
      const manifest = await json(join(profile, 'package.json'))
      manifest.dsh.profile.bundles = [RUNTIME_BUNDLE]
      await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
      assert.equal(runtimeStatus(profile).ready, true)
      const trace = join(home, 'update-trace.jsonl')
      const control = join(profile, '.fixture-update.json')
      await writeFile(control, JSON.stringify({ trace, oldRoot, failPrepare }))
      const outcome = await run(process.execPath, [fileURLToPath(import.meta.url), '--update'], { env: {
        ...env, DSH_UPDATE_OLD_ENTRY: join(oldRoot, 'lib/types/update.js'), DSH_UPDATE_RUNNING_VERSION: '1.0.0',
      } })
      assert.equal(outcome.code, failPrepare ? 1 : 0, outcome.output)
      assert.ok(existsSync(trace), outcome.output)
      const operations = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const preparation = operations.find(operation => operation.args[0] === 'add' && operation.args.some(arg => arg.startsWith('file:')))
      assert.ok(preparation, 'private runtime preparation ran before the updater completed')
      assert.equal(preparation.old, '1.0.0', 'old physical package still exists during post-install verification')
      assert.equal(preparation.direct, '2.0.0', 'preparation uses the new profile package')
      for (const operation of operations) assert.deepEqual(operation.lock, operations[0].lock, 'one setup lock spans public and private package operations')
      assert.equal((await json(join(packageRoot(profile), 'package.json'))).version, '2.0.0')
      const privateManifest = await json(join(profile, 'node_modules', RUNTIME_BUNDLE, 'package.json'))
      assert.equal(privateManifest.version, failPrepare ? '1.0.0' : '2.0.0')
      assert.equal(privateManifest.dependencies[PACKAGE], privateManifest.version)
      const privateAnchor = await realpath(join(profile, 'node_modules', RUNTIME_BUNDLE, 'package.json'))
      assert.equal((await json(createRequire(privateAnchor).resolve(`${PACKAGE}/package.json`))).version, privateManifest.version, 'the selected runtime resolves the matching public package')
      assert.equal(runtimeStatus(profile).ready, !failPrepare)
      if (!failPrepare) assert.deepEqual((await json(join(profile, 'package.json'))).dsh.profile.bundles, [RUNTIME_BUNDLE])
      assert.equal(existsSync(join(profile, '.dsh-tui/setup.json.lock')), false, 'setup lock released on success and failure')
      console.log(`PASS: headless update ${failPrepare ? 'rejects failed private preparation' : 'returns success only after public/private runtime match'}`)
      if (failPrepare) {
        await writeFile(trace, '')
        await writeFile(control, JSON.stringify({ trace, oldRoot, failPrepare: false }))
        const currentRoot = await realpath(packageRoot(profile))
        const retried = await run(process.execPath, [fileURLToPath(import.meta.url), '--update'], { env: {
          ...env, DSH_UPDATE_OLD_ENTRY: join(currentRoot, 'lib/types/update.js'), DSH_UPDATE_RUNNING_VERSION: '2.0.0',
        } })
        assert.equal(retried.code, 0, retried.output)
        assert.equal(runtimeStatus(profile).ready, true, 'already-latest retry repairs the unfinished private runtime')
        assert.deepEqual((await json(join(profile, 'package.json'))).dsh.profile.bundles, [RUNTIME_BUNDLE])
        const repairedAnchor = await realpath(join(profile, 'node_modules', RUNTIME_BUNDLE, 'package.json'))
        assert.equal((await json(repairedAnchor)).version, '2.0.0')
        assert.equal((await json(createRequire(repairedAnchor).resolve(`${PACKAGE}/package.json`))).version, '2.0.0')
        const retryOperations = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        assert.ok(retryOperations.some(operation => operation.args[0] === 'add' && operation.args.some(arg => arg.startsWith('file:'))))
        assert.ok(!retryOperations.some(operation => operation.args[0] === 'update'), 'already-current public package is not installed again')
        assert.equal(existsSync(join(profile, '.dsh-tui/setup.json.lock')), false)
        console.log('PASS: already-latest retry repairs the failed private update before success')
      }
    }
  } finally {
    if (server) await new Promise(resolveClose => server.close(resolveClose))
    await rm(scratch, { recursive: true, force: true })
  }
}
