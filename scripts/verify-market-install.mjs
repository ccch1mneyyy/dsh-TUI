/**
 * Real official PluginManager + Loader install/enable regression, isolated HOME.
 * Requires a compiled application and network access for uncached dependencies.
 * The fixture registry serves this build under the existing npm identity; an
 * isolated Git URL rewrite tests the bare GitHub input without publishing it.
 * No model requests, user profiles, Git configuration or public releases change.
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { createServer, request as requestHttp } from 'node:http'
import { createServer as createHttpsServer, request as requestHttps } from 'node:https'
import { connect, createServer as createLeaseMarker } from 'node:net'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import { initProfile, mountRootInclude, readProfilePatches, recomposeProfile } from '@deepseek-ai/dsh-app-boot'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { compareVersions, liveRuntimeProcesses, PACKAGE, PROFILE, readJson, RUNTIME_BUNDLE, runtimeStatus } from '../src/dsh-adapter/market/runtime-profile.mjs'
import { prepareRuntime } from '../src/dsh-adapter/market/prepare.mjs'
import * as ProfileManager from '../src/dsh-adapter/market/manager.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-tui-market-'))
const manifest = readJson(join(root, 'package.json'))
const pnpm = process.env.DSH_TUI_VERIFY_PNPM
// Pin package operations too: `pnpm` in a consumer profile can otherwise
// select a different global version from the project's packageManager.
let pnpmInvocation = pnpm === undefined ? undefined
  : /\.[cm]js$/u.test(pnpm) ? { command: process.execPath, args: [pnpm] } : { command: pnpm, args: [] }
const results = []
// Mirror the official HMR transaction contract instead of accepting unsafe calls.
function fixtureHmr(reconcile, beforeExclusive = () => {}) {
  const executing = new AsyncLocalStorage()
  return {
    runExclusive: callback => {
      beforeExclusive()
      return executing.run(true, callback)
    },
    reconcileProfile: async (requiredIds = []) => {
      assert.equal(executing.getStore(), true, 'HMR profile reconciliation must run inside runExclusive')
      return reconcile(requiredIds)
    },
  }
}
const waitFor = async (predicate, description, timeout = 30000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let stdout = ''
  child.stdout.on('data', chunk => { output += chunk; stdout += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(' ')} (${code})\n${output}`)))
})
if (pnpmInvocation === undefined) {
  // Resolve the pinned JS CLI once in an empty directory. Running npm exec
  // inside each consumer project would also inspect that project's dependency
  // tree, including the vendors' intentionally bundled workspace protocols.
  const locate = `
    const fs = require('node:fs'), path = require('node:path')
    const shim = process.env.PATH.split(path.delimiter).map(dir => path.join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')).find(file => fs.existsSync(file))
    const cli = process.platform === 'win32' ? path.resolve(path.dirname(shim), '../pnpm/bin/pnpm.cjs') : fs.realpathSync(shim)
    // Prefer the official Corepack-compatible entry on every platform.
    const compatible = path.join(path.dirname(cli), 'pnpm.cjs')
    process.stdout.write(fs.existsSync(compatible) ? compatible : cli)
  `
  const cli = (await run('npm', ['exec', '--yes', `--package=${manifest.packageManager}`, '--', process.execPath, '-e', locate], { cwd: scratch })).trim()
  assert.ok(cli.endsWith('.cjs') || cli.endsWith('.mjs'), 'the pinned pnpm must expose a JS CLI')
  pnpmInvocation = { command: process.execPath, args: [cli] }
}

for (const [a, b, expected] of [['1.0.0', '1.0.0-rc.1', 1], ['1.0.0-rc.2', '1.0.0-rc.10', -1], ['1.1.0', '1.0.9', 1], ['1.0.0+a', '1.0.0+b', 0]]) {
  assert.equal(compareVersions(a, b), expected)
}
await run(process.execPath, ['scripts/with-publish-manifest.mjs', 'npm', 'pack', '--ignore-scripts', '--pack-destination', scratch])
const tarballPath = join(scratch, (await readdir(scratch)).find(name => name.endsWith('.tgz')))
const tarball = await readFile(tarballPath)
const published = JSON.parse(await run('tar', ['-xOf', tarballPath, 'package/package.json']))
assert.equal(published.dsh.bundle.patch, './market.patch.yml')
assert.ok(published.dependencies.react)
assert.equal(published.scripts.prepare, undefined)
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0])
  if (path === `/${PACKAGE}`) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: PACKAGE, 'dist-tags': { latest: manifest.version }, versions: {
      [manifest.version]: { ...published, dist: { tarball: `${registry}/runtime.tgz`, integrity } },
    } }))
  } else if (path === '/runtime.tgz') res.end(tarball)
  else { res.writeHead(302, { location: `https://registry.npmjs.org${req.url}` }); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const registry = `http://127.0.0.1:${server.address().port}`
const runPnpm = (args, options) => run(pnpmInvocation.command, [...pnpmInvocation.args, ...args], { cwd: scratch, ...options })
const pnpmVersion = (await runPnpm(['--version'])).trim()
const store = (await runPnpm(['store', 'path'])).trim().split('\n').at(-1)
const repo = join(scratch, 'git-source')
await mkdir(repo)
for (const path of ['package.json', 'pnpm-workspace.yaml', '.gitmodules', '.npmrc', 'market.patch.yml', 'bin', 'src/dsh-adapter/market']) {
  await cp(join(root, path), join(repo, path), { recursive: true })
}
await run('git', ['init', '--initial-branch=main'], { cwd: repo })
await run('git', ['add', 'package.json', 'pnpm-workspace.yaml', '.gitmodules', '.npmrc', 'market.patch.yml', 'bin', 'src'], { cwd: repo })
await run('git', ['-c', 'user.name=Install fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'isolated install fixture'], { cwd: repo })
await run('git', ['clone', '--bare', repo, `${repo}.git`])
const github = 'https://github.com/ccch1mneyyy/dsh-TUI'
const gitEnv = {
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo).href}.insteadOf`, GIT_CONFIG_VALUE_0: github,
  GIT_ALLOW_PROTOCOL: 'file:https',
}
// pnpm 11 downloads GitHub's archive after resolving HEAD through git. Serve
// that archive through a fixture-only TLS proxy, with an extra child-process
// CA rather than changing DNS, trust stores or the public repository.
const certificate = join(scratch, 'github-fixture.crt')
const key = join(scratch, 'github-fixture.key')
await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=codeload.github.com', '-addext', 'subjectAltName=DNS:codeload.github.com',
  '-keyout', key, '-out', certificate])
const sourceArchive = join(scratch, 'git-source.tar.gz')
await run('git', ['archive', '--format=tar.gz', '--prefix=dsh-TUI/', '-o', sourceArchive, 'HEAD'], { cwd: repo })
const archive = await readFile(sourceArchive)
let githubArchiveRequests = 0
const archiveServer = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, (req, res) => {
  if (!req.url.startsWith('/ccch1mneyyy/dsh-TUI/tar.gz/')) { res.writeHead(404); res.end(); return }
  githubArchiveRequests++
  res.end(archive)
})
await new Promise(resolve => archiveServer.listen(0, '127.0.0.1', resolve))
const sockets = new Set()
for (const instance of [server, archiveServer]) instance.on('connection', socket => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})
server.on('connect', (req, socket, head) => {
  const destination = new URL(`https://${req.url}`)
  const fixture = destination.hostname === 'codeload.github.com'
  const connected = (upstream, upstreamHead = Buffer.alloc(0)) => {
    if (socket.destroyed) { upstream.destroy(); return }
    upstream.on('error', () => socket.destroy())
    socket.once('close', () => upstream.destroy())
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  }
  // Keep the fixture local while preserving the environment's outbound proxy.
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
  if (!fixture && proxy) {
    const url = new URL(proxy)
    const headers = { host: req.url }
    if (url.username || url.password) {
      headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
      url.username = url.password = ''
    }
    const tunnel = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, { method: 'CONNECT', path: req.url, headers })
    tunnel.once('connect', (response, upstream, upstreamHead) => {
      if (response.statusCode === 200) connected(upstream, upstreamHead)
      else { upstream.destroy(); socket.destroy() }
    })
    tunnel.on('error', () => socket.destroy())
    socket.on('error', () => tunnel.destroy())
    socket.once('close', () => tunnel.destroy())
    tunnel.end()
    return
  }
  const upstream = connect(fixture ? archiveServer.address().port : Number(destination.port || 443), fixture ? '127.0.0.1' : destination.hostname)
  upstream.once('connect', () => connected(upstream))
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.once('close', () => upstream.destroy())
})
gitEnv.NODE_EXTRA_CA_CERTS = certificate
if (process.env.NODE_EXTRA_CA_CERTS) {
  // Retain the caller's proxy CA while trusting the local GitHub fixture.
  const combinedCertificate = join(scratch, 'fixture-extra-ca.crt')
  await writeFile(combinedCertificate, `${await readFile(process.env.NODE_EXTRA_CA_CERTS, 'utf8')}\n${await readFile(certificate, 'utf8')}`)
  gitEnv.NODE_EXTRA_CA_CERTS = combinedCertificate
}

async function directProfileStartup(source, target) {
  const selected = readJson(join(target, 'package.json'))
  selected.dsh.profile.bundles = selected.dsh.profile.bundles.map(name => name === RUNTIME_BUNDLE ? PACKAGE : name)
  await writeFile(join(target, 'package.json'), `${JSON.stringify(selected, null, 2)}\n`)
  assert.equal(runtimeStatus(target).ready, false)
  const ctx = new Context()
  let onReady
  let reconciled = 0
  let exitCode
  ctx.provide('profileContext', { ...source, name: PROFILE, dir: target, patchPath: join(target, 'cordis.patch.yml') })
  ctx.provide('appReady', { onReady(callback) { onReady = callback; return () => { onReady = undefined } } })
  ctx.provide('appExit', code => { exitCode = code })
  ctx.provide('hmr', fixtureHmr(() => {
    assert.equal(runtimeStatus(target).ready, true, 'prepare finishes before reconciling the direct profile')
    reconciled++
    return { warnings: [], pending: [] }
  }, () => {
    assert.equal(runtimeStatus(target).ready, false, 'direct-profile preparation begins inside the HMR transaction')
  }))
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(ProfileManager)
    assert.equal(typeof onReady, 'function', 'own-profile startup schedules preparation after appReady')
    onReady()
    await waitFor(() => reconciled > 0 || exitCode !== undefined, 'direct-profile preparation and reconciliation')
    assert.equal(exitCode, undefined, 'the first direct-profile launch must not request appExit')
    assert.equal(reconciled, 1, 'direct-profile startup reconciles once inside the HMR transaction')
    assert.equal(runtimeStatus(target).ready, true)
  } finally { await ctx.fiber.dispose() }
}

async function terminalLaunch(source, target, fullscreen, repairEntry = false, directProfile = false) {
  const { findHostDsh } = await import('../lib/types/dsh-adapter/host-dsh.js')
  const found = findHostDsh()
  assert.ok(found.packageDir, 'terminal verification requires the official dsh CLI')
  const pty = createRequire(join(found.packageDir, 'package.json'))('node-pty')
  const { default: xterm } = await import('@xterm/headless')
  const home = join(source.home, `terminal-${fullscreen ? 'fullscreen' : 'inline'}`)
  await mkdir(join(home, '.dsh-tui'), { recursive: true })
  await writeFile(join(home, '.dsh-tui/onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
  // This is a present-day explicit inline choice, after the old default migration.
  await writeFile(join(home, '.dsh-tui/migrations.json'), JSON.stringify({ 'fullscreen-factory-default': Date.now() }))
  // A profile-layer override exercises its precedence above the internal bundle.
  const patches = parseYaml(await readFile(join(target, 'node_modules', ...PACKAGE.split('/'), 'cordis.patch.yml'), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ js: value }) }],
  })
  const config = patches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'dsh-tui').config
  config.fullscreen = fullscreen
  if (!directProfile) {
    await writeFile(join(target, 'cordis.patch.yml'), stringifyYaml([{ id: 'dsh-tui', config }], {
      customTags: [{ tag: 'tag:yaml.org,2002:js', identify: value => typeof value?.js === 'string', stringify: ({ value }) => value.js }],
    }))
  }
  const columns = fullscreen ? 100 : 45
  const terminal = new xterm.Terminal({ cols: columns, rows: 28, scrollback: 1000, allowProposedApi: true })
  if (repairEntry) {
    const selected = readJson(join(target, 'package.json'))
    selected.dsh.profile.bundles = selected.dsh.profile.bundles.filter(name => name !== RUNTIME_BUNDLE)
    await writeFile(join(target, 'package.json'), `${JSON.stringify(selected, null, 2)}\n`)
    assert.equal(runtimeStatus(target).ready, false)
  }
  const entry = directProfile
    ? [join(found.packageDir, readJson(join(found.packageDir, 'package.json')).bin.dsh), '--profile', PROFILE]
    : [join(target, 'node_modules', ...PACKAGE.split('/'), repairEntry ? 'lib/types/dsh-adapter/host-entry.js' : 'bin/dsh-tui.js')]
  const spawnOptions = {
    cwd: scratch, cols: columns, rows: 28, name: 'xterm-256color',
    env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: source.home,
      // Keep the installed store when isolating terminal state under another HOME.
      PNPM_CONFIG_STORE_DIR: dirname(store),
      DSH_TUI_LANG: 'en', DSH_TUI_SESSION_ROOT: join(home, 'sessions'), DSH_TUI_WORKSPACE_TARGET: scratch,
      // Cover both hosts: the application entry and the direct official profile.
      // The landing page uses an alternate screen even in inline chat mode.
      ...(fullscreen ? {} : { DSH_TUI_HOST_ENTRY: '0', DSH_TUI_NO_LAUNCHPAD: '1' }),
      DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'fixture-unused-no-model-requests', TERM: 'xterm-256color',
    },
  }
  let output = ''
  let exit
  let child
  const exitCodes = []
  const launch = () => {
    exit = undefined
    const current = pty.spawn(process.execPath, entry, spawnOptions)
    child = current
    current.onData(data => { output += data; if (child === current) terminal.write(data) })
    current.onExit(event => { if (child === current) exit = event })
  }
  terminal.onData(data => { if (exit === undefined) child.write(data) })
  launch()
  const screen = () => Array.from({ length: 28 }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true) ?? '').join('\n')
  const adopted = () => exit !== undefined || (readJson(join(home, '.dsh-tui/inject/servers.json')) ?? []).some(record => record.sessionId)
  try {
    await waitFor(adopted, 'adopted terminal session')
    if (directProfile && exit?.exitCode === 1) {
      // A tarball's public package and the private bundle's registry pin can
      // have distinct physical paths. Only the explicit, ready restart
      // outcome may retry once; a timeout or an unrelated failure still fails.
      const expected = '[dsh-tui] The TUI profile is prepared, but DSH requires a restart to load its updated packages (package-moved).\n'
        + `Run again with the same DSH_HOME: dsh --profile ${PROFILE}\n`
      assert.ok(output.replace(/\r\n/gu, '\n').includes(expected), output.slice(-12000))
      assert.equal(runtimeStatus(target).ready, true, 'a controlled first-launch restart requires a prepared profile')
      exitCodes.push(exit.exitCode)
      await writeFile(join(home, 'first-launch.log'), output)
      console.log('market-install: fresh official profile → explicit package-moved restart (exit 1)')
      terminal.reset()
      launch()
      await waitFor(adopted, 'adopted terminal session after controlled restart')
    }
    assert.equal(exit, undefined, output.slice(-12000))
    await waitFor(async () => (await liveRuntimeProcesses(target)).length > 0, 'runtime lease')
    assert.equal(runtimeStatus(target).ready, true, 'the application entry repairs an incomplete selection')
    await assert.rejects(prepareRuntime({ Context, Loader, source, version: '99.0.0' }), /Close the running TUI/)
    await waitFor(() => screen().includes('❯'), 'terminal prompt')
    await waitFor(() => terminal.buffer.active.type === (fullscreen ? 'alternate' : 'normal'), 'profile fullscreen override')
    await writeFile(join(home, 'screen.txt'), `${screen()}\n`)
    child.write('/quit')
    await waitFor(() => screen().includes('/quit'), 'terminal command input')
    child.write('\r')
    await waitFor(() => exit !== undefined, 'terminal exit')
    assert.equal(exit.exitCode, 0, output.slice(-12000))
    exitCodes.push(exit.exitCode)
    assert.deepEqual(readJson(join(target, '.dsh-tui/running.json')), [], 'normal exit releases its lease')
    assert.ok(output.includes('\x1b[?25h'), 'exit restores the terminal cursor')
    console.log(`market-install: ${directProfile ? 'fresh official profile' : 'terminal'} ${fullscreen ? 'fullscreen 100' : 'inline 45'} columns → /quit OK`)
    return { controlledRestart: exitCodes.length === 2, exitCodes }
  } finally {
    if (exit === undefined) child.kill()
    await writeFile(join(home, 'terminal.log'), output)
    terminal.dispose()
    await writeFile(join(target, 'cordis.patch.yml'), '[]\n')
  }
}

try {
  for (const [name, spec] of [['npm', `${PACKAGE}@${manifest.version}`], ['github', github]]) {
    console.log(`market-install: ${name} install → enable → ready`)
    const home = join(scratch, name)
    const dir = join(home, 'profiles', 'web')
    const target = join(home, 'profiles', PROFILE)
    initProfile(dir, [])
    // pnpm is real, including the official package invocation and frozen lockfile.
    await writeFile(join(dir, '.npmrc'), `registry=${registry}\nstore-dir=${store}\nhttps-proxy=${registry}\n`)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, '.npmrc'), `registry=${registry}\nstore-dir=${store}\nhttps-proxy=${registry}\n`)
    const source = {
      name: 'web', home, dir, cwd: root, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [],
      packageManager: { ...pnpmInvocation, env: gitEnv },
    }
    const ctx = new Context()
    ctx.provide('profileContext', source)
    await ctx.plugin(Loader)
    const empty = join(dir, 'root.yml')
    await writeFile(empty, '[]\n')
    await mountRootInclude(ctx, empty, readProfilePatches('dsh', source))
    // Use the official recomposer, including required-entry failure checks.
    ctx.provide('hmr', fixtureHmr(async requiredIds => ({
      ...await recomposeProfile(ctx, readProfilePatches('dsh', source), 'dsh', { requiredIds }), pending: [],
    })))
    await ctx.plugin(PluginManager, { registry, fallbackRegistries: [] })
    try {
      const manager = ctx.get('pluginManager')
      const installed = await manager.installBundle(spec, { enabled: false, saveExact: true })
      assert.equal(installed.application, 'applied', JSON.stringify(installed))
      assert.equal(ctx.get('tuiProfileManager'), undefined, 'installation must remain disabled like the official UI')
      assert.equal(runtimeStatus(target).ready, false)
      if (name === 'github') {
        const gitPackage = join(dir, 'node_modules', ...PACKAGE.split('/'))
        assert.equal(readJson(join(gitPackage, 'package.json')).scripts.prepare, undefined)
        assert.equal(readJson(join(gitPackage, 'lib/tui-runtime/package.json')), undefined, 'Git did not receive compiled artifacts')
      }
      const selectedBeforeEnable = readJson(join(dir, 'package.json'))
      // A rejected preparation must leave the management service available.
      await mkdir(join(target, '.dsh-tui'), { recursive: true })
      const marker = createLeaseMarker(socket => { socket.on('error', () => {}); socket.end('fixture-running-tui\n') })
      await new Promise(resolve => marker.listen(0, '127.0.0.1', resolve))
      try {
        await writeFile(join(target, '.dsh-tui/running.json'), JSON.stringify([{ pid: process.pid, token: 'fixture-running-tui', port: marker.address().port }]))
        const rejected = await manager.setBundleEnabled(PACKAGE, true)
        assert.equal(rejected.application, 'failed', 'an unprepared environment cannot report enabled successfully')
        assert.equal(ctx.get('tuiProfileManager').status().phase, 'failed')
      } finally { await new Promise(resolve => marker.close(resolve)) }
      await writeFile(join(target, '.dsh-tui/running.json'), '[]\n')
      await manager.setBundleEnabled(PACKAGE, false)
      const enabled = await manager.setBundleEnabled(PACKAGE, true)
      assert.equal(enabled.application, 'applied', JSON.stringify(enabled))
      const service = ctx.get('tuiProfileManager')
      assert.ok(service, 'the native entry registered its service')
      assert.deepEqual(remoteMethods(service).map(x => x.method), ['status', 'prepare', 'cancel'])
      const status = service.status()
      assert.equal(status.ready, true, JSON.stringify(status))
      const commands = new Map()
      ctx.provide('commands', { register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      } })
      await waitFor(() => commands.size === 2, 'late command registration')
      const commandStatus = await commands.get('tui-status').handler({})
      assert.equal(commandStatus.kind, 'success')
      assert.equal(JSON.parse(commandStatus.text).ready, true)
      assert.equal(status.version, manifest.version)
      assert.ok(readJson(join(target, 'package.json')).dsh.profile.bundles.includes(RUNTIME_BUNDLE))
      assert.ok(!readJson(join(target, 'package.json')).dsh.profile.bundles.includes(PACKAGE), 'the public management layer must not duplicate an old global TUI patch')
      assert.equal(readJson(join(dir, 'package.json')).dependencies[RUNTIME_BUNDLE], undefined, 'runtime bundle must stay out of the UI profile')
      assert.equal(readJson(join(dir, 'package.json')).dependencies[PACKAGE], selectedBeforeEnable.dependencies[PACKAGE])
      assert.ok(![...ctx.loader.entries()].some(entry => entry.id === 'dsh-tui'), 'the UI profile must never mount the terminal')
      const before = await readFile(join(target, 'package.json'), 'utf8')
      await service.prepare()
      assert.equal(await readFile(join(target, 'package.json'), 'utf8'), before, 'preparation is idempotent')
      await prepareRuntime({ Context, Loader, source, version: '0.0.1' })
      assert.equal(await readFile(join(target, 'package.json'), 'utf8'), before, 'an older entry cannot downgrade the runtime')
      await rm(join(target, 'node_modules'), { recursive: true, force: true })
      assert.equal(runtimeStatus(target).ready, false)
      await runPnpm(['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: target, env: { ...process.env, ...gitEnv } })
      assert.equal(runtimeStatus(target).ready, true, 'stable recipe must survive cold reinstall')
      await directProfileStartup(source, target)
      console.log(`market-install: ${name} first direct-profile preparation → exclusive reconciliation OK`)
      if (process.argv.includes('--terminal')) {
        await terminalLaunch(source, target, true, name === 'npm')
        await terminalLaunch(source, target, false)
      }
      results.push({ source: name, spec, installed: installed.application, enabled: enabled.application, version: status.version, coldReinstall: true, failureRetry: true, ...(process.argv.includes('--terminal') ? { terminal: ['application entry fullscreen 100', 'official profile inline 45'] } : {}), profileDir: target })
    } finally { await ctx.fiber.dispose() }
  }
  if (process.argv.includes('--terminal')) {
    const { findHostDsh } = await import('../lib/types/dsh-adapter/host-dsh.js')
    const found = findHostDsh()
    assert.ok(found.packageDir, 'direct-profile verification requires the official dsh CLI')
    const home = join(scratch, 'direct-profile')
    const target = join(home, 'profiles', PROFILE)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, '.npmrc'), `registry=${registry}\nstore-dir=${store}\nhttps-proxy=${registry}\n`)
    const bin = join(found.packageDir, readJson(join(found.packageDir, 'package.json')).bin.dsh)
    await run(process.execPath, [bin, 'plugin', '--profile', PROFILE, 'add', tarballPath], {
      env: { ...process.env, ...gitEnv, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    })
    assert.equal(runtimeStatus(target).ready, false, 'the first official launch begins before runtime preparation')
    const terminal = await terminalLaunch({ home, installAnchor: join(root, 'package.json'), packageManager: pnpmInvocation }, target, true, false, true)
    results.push({ source: 'direct-profile', freshInstall: true, terminal: ['official HMR first launch fullscreen 100'], ...terminal, profileDir: target })
  }
  if (pnpmVersion.startsWith('11.')) assert.ok(githubArchiveRequests > 0, 'pnpm 11 exercised the GitHub source archive transport')
  await writeFile(join(scratch, 'result.json'), JSON.stringify({ passed: true, pnpmVersion, githubArchiveRequests, results }, null, 2))
  console.log(`market-install OK; isolated evidence: ${scratch}`)
} finally {
  for (const socket of sockets) socket.destroy()
  await Promise.all([server, archiveServer].map(instance => new Promise(resolve => instance.close(resolve))))
}
