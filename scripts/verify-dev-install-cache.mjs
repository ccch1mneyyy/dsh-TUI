#!/usr/bin/env node
/**
 * Run: node scripts/verify-dev-install-cache.mjs (no build/network required).
 * Executes the real dev-test control flow in an equivalent checkout, including
 * CLAUDE.md -> AGENTS.md, with controlled pnpm/npm/dsh child processes. Timings
 * measure this fixture only, not a production installation or compiler speed.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeHash, devInputHash } from './lib/dev-install-cache.mjs'

if (process.platform === 'win32') {
  console.log('SKIP: POSIX executable fixture; Windows command quoting is covered by verify-dev-command.mjs')
  process.exit(0)
}
const root = mkdtempSync(join(tmpdir(), 'dev-cache-flow-'))
const source = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = join(root, 'repo')
const dev = join(root, 'dev')
const tools = join(root, 'tools')
const log = join(root, 'calls.jsonl')
const stamp = join(dev, 'dev-install-cache.json')
const installed = join(dev, 'dsh-home/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui')
const put = (path, value = 'fixture\n') => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}
try {
  for (const file of ['dev-test.mjs', 'dev-command.mjs', 'dev-copy-config.mjs', 'lib/dev-install-cache.mjs']) {
    const target = join(repo, 'scripts', file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, 'scripts', file), target)
  }
  put(join(repo, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '1.0.0', type: 'module' }))
  for (const file of ['AGENTS.md', 'src/app.ts', 'scripts/compiler.mjs', 'pnpm-lock.yaml', 'cordis.patch.yml', 'presets/base.yml', 'assets/icon.txt', 'bin/dsh-tui.js']) put(join(repo, file))
  symlinkSync('AGENTS.md', join(repo, 'CLAUDE.md'))
  for (const file of ['.modules.yaml', '.pnpm/lock.yaml']) put(join(repo, 'node_modules', file))
  const toolRoots = Object.fromEntries(['typescript@6.0.3', 'tsx@4.23.15', 'esbuild@0.28.2'].map(spec => {
    const name = spec.split('@')[0]
    return [name, join(repo, 'node_modules/.pnpm', spec, 'node_modules', name)]
  }))
  put(join(toolRoots.typescript, 'lib/tsc.js'))
  put(join(toolRoots.tsx, 'package.json'), JSON.stringify({ name: 'tsx', exports: './dist/loader.mjs' }))
  put(join(toolRoots.tsx, 'dist/loader.mjs'))
  put(join(toolRoots.esbuild, 'package.json'), JSON.stringify({ name: 'esbuild', main: 'lib/main.js' }))
  put(join(toolRoots.esbuild, 'lib/main.js'))
  put(join(toolRoots.esbuild, 'bin/esbuild'))
  for (const name of ['typescript', 'tsx']) symlinkSync(toolRoots[name], join(repo, 'node_modules', name))
  symlinkSync('../../esbuild@0.28.2/node_modules/esbuild', join(dirname(toolRoots.tsx), 'esbuild'))
  assert.equal(existsSync(join(repo, 'node_modules/esbuild')), false, 'pnpm does not expose transitive esbuild at the repository root')
  for (const name of ['core', 'manifest', 'connection', 'presentation', 'command', 'storage', 'messages']) put(join(repo, `vendor/dsh-std/packages/${name}/lib/index.js`))
  put(join(repo, 'vendor/mathjax-tex-svg/lib/index.js'))
  const stub = `#!${process.execPath}
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
const tool = basename(process.argv[1])
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('11.21.0'); process.exit(0) }
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify([tool, ...args]) + '\\n')
if (process.env.FIXTURE_FAIL === tool + ':' + args[0]) process.exit(9)
const put = (file, content) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content) }
const payload = ['package.json', 'bin/dsh-tui.js', 'cordis.patch.yml', 'lib/types/index.js', 'lib/types/extra.js', 'presets/base.yml', 'assets/icon.txt']
if (tool === 'pnpm' && ['compile', 'build'].includes(args[0])) {
  put(join(process.cwd(), 'lib/types/index.js'), readFileSync('src/app.ts'))
  put(join(process.cwd(), 'lib/types/extra.js'), 'extra artifact')
}
if (tool === 'npm' && args[0] === 'pack') {
  put(join(args[args.indexOf('--pack-destination') + 1], 'fixture.tgz'), 'tarball:' + readFileSync('src/app.ts'))
  if (args.includes('--json')) console.log(JSON.stringify([{ files: payload.map(path => ({ path })) }]))
}
if (tool === 'dsh' && args[0] === 'plugin') {
  const profile = join(process.env.DSH_HOME, 'profiles/dsh-tui')
  put(join(profile, 'package.json'), '{"dependencies":{"fixture":"file:fixture.tgz"}}')
  const installed = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui')
  const packageDir = join(profile, 'node_modules/.pnpm/fixture/node_modules/@deepseek-harness-tui/dsh-tui')
  mkdirSync(packageDir, { recursive: true })
  mkdirSync(dirname(installed), { recursive: true })
  if (!existsSync(installed)) symlinkSync('../.pnpm/fixture/node_modules/@deepseek-harness-tui/dsh-tui', installed)
  for (const file of payload) {
    mkdirSync(dirname(join(installed, file)), { recursive: true })
    copyFileSync(file, join(installed, file))
  }
  if (process.env.FIXTURE_STALE) put(join(installed, process.env.FIXTURE_STALE), 'stale payload')
}
`
  put(join(tools, 'package.json'), '{"type":"module"}')
  for (const name of ['pnpm', 'npm', 'dsh']) {
    put(join(tools, name), stub)
    chmodSync(join(tools, name), 0o755)
  }
  const run = (label, { fail, stale = '', fast = true, hit = false, cacheable = true } = {}) => {
    put(log, '')
    const start = performance.now()
    const result = spawnSync(process.execPath, [join(repo, 'scripts/dev-test.mjs'), '--', '--no-launch'], {
      cwd: repo, encoding: 'utf8', timeout: 20000,
      env: { PATH: tools, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), DSH_TUI_DEV_ROOT: dev,
        DSH_TUI_DEV_FAST: fast ? '1' : '0', FIXTURE_LOG: log, FIXTURE_STALE: stale, ...(fail ? { FIXTURE_FAIL: fail } : {}) },
    })
    assert.ifError(result.error)
    assert.equal(result.status, fail || stale ? 1 : 0, `${label}: ${result.stdout}\n${result.stderr}`)
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (fail || stale) {
      assert.equal(existsSync(stamp), false, `${label}: failure must invalidate success stamp`)
      assert.doesNotMatch(result.stdout, /cache hit/u)
    } else if (hit) {
      assert.deepEqual(calls, [], `${label}: must skip all four stages`)
      assert.match(result.stdout, /cache hit; skipping install, compile, pack and plugin add/u)
    } else {
      assert.deepEqual(calls.map(call => call.slice(0, 2)), [['pnpm', 'install'], ['pnpm', fast ? 'compile' : 'build'], ['npm', 'pack'], ['dsh', 'plugin']], label)
      assert.equal(calls[2].includes('--ignore-scripts'), fast)
      assert.equal(existsSync(stamp), fast && cacheable, `${label}: only verified success may stamp`)
      assert.match(result.stdout, /pnpm install took [\d.]+s/u)
      assert.match(result.stdout, /dsh plugin took [\d.]+s/u)
    }
    console.log(`PASS ${label}: ${(performance.now() - start).toFixed(1)}ms; ${calls.length} work stages`)
    if (label === 'cold' || label === 'warm') console.log(result.stdout.trim())
  }
  run('cold')
  run('warm', { hit: true })
  assert.equal(devInputHash(repo, repo), undefined, 'the development root cannot exclude the whole repository')
  const dependency = join(dev, 'dsh-home/profiles/dsh-tui/node_modules/dependency/index.js')
  put(dependency, 'dependency original')
  run('new profile dependency')
  put(dependency, 'dependency changed')
  run('changed profile dependency')
  rmSync(dependency)
  run('deleted profile dependency')
  put(join(repo, 'src/app.ts'), 'force extra-file validation\n')
  run('installed obsolete file', { stale: 'obsolete.js' })
  rmSync(join(installed, 'obsolete.js'))
  run('recover obsolete file')
  put(join(repo, 'src/app.ts'), 'new module\n')
  run('successful installer with stale non-entry module', { stale: 'lib/types/extra.js' })
  run('recover stale compiled payload')
  for (const payload of ['presets/base.yml', 'assets/icon.txt']) {
    put(join(repo, payload), 'updated payload\n')
    run(`successful installer with stale ${payload}`, { stale: payload })
    run(`recover ${payload}`)
  }
  for (const file of ['src/app.ts', 'pnpm-lock.yaml', 'cordis.patch.yml', 'presets/base.yml', 'assets/icon.txt', 'scripts/compiler.mjs', 'package.json', 'node_modules/typescript/lib/tsc.js', 'node_modules/tsx/dist/loader.mjs', 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js', 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild', 'lib/types/extra.js', 'vendor/dsh-std/packages/core/lib/index.js']) {
    const path = join(repo, file)
    if (file === 'package.json') {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      put(path, JSON.stringify({ ...manifest, files: ['lib', 'bin'] }))
    } else put(path, readFileSync(path, 'utf8') + 'changed\n')
    run(`invalidate ${file}`)
    run(`reuse ${file}`, { hit: true })
  }
  for (const path of [join(installed, 'lib/types/extra.js'), join(dev, 'dsh-home/profiles/dsh-tui/package.json')]) {
    put(path, readFileSync(path, 'utf8') + 'changed')
    run(`invalidate ${path.replace(root, '')}`)
  }
  const tarball = JSON.parse(readFileSync(stamp, 'utf8')).tarball
  put(tarball, readFileSync(tarball, 'utf8') + 'changed')
  run('invalidate tarball')
  // An internal symlink target is part of the input hash, even if both targets
  // have identical contents. Neither directory nor cyclic links are followed.
  put(join(repo, 'AGENTS2.md'), readFileSync(join(repo, 'AGENTS.md')))
  run('new target file')
  rmSync(join(repo, 'CLAUDE.md'))
  symlinkSync('AGENTS2.md', join(repo, 'CLAUDE.md'))
  run('changed symlink target')
  run('symlink warm', { hit: true })
  for (const stage of ['pnpm:install', 'pnpm:compile', 'npm:pack', 'dsh:plugin']) {
    put(join(repo, 'src/app.ts'), `${stage}\n`)
    run(`failure ${stage}`, { fail: stage })
    run(`recover ${stage}`)
    run(`recovered warm ${stage}`, { hit: true })
  }
  const loader = join(toolRoots.tsx, 'dist/loader.mjs')
  const loaderContents = readFileSync(loader)
  rmSync(loader)
  run('unresolvable tsx compiler', { cacheable: false })
  put(loader, loaderContents)
  run('recover tsx compiler')
  run('recovered compiler warm', { hit: true })
  run('default retains build and pack lifecycle', { fast: false })
  assert.equal(existsSync(stamp), false)
  // The filesystem follows the directory link before resolving "..". Its
  // lexical target is an internal decoy; the actual source is outside repo.
  put(join(root, 'outside.ts'), 'first actual external source\n')
  put(join(repo, 'outside.ts'), 'decoy inside repo\n')
  symlinkSync('.', join(repo, 'back'))
  rmSync(join(repo, 'src/app.ts'))
  symlinkSync('../back/../outside.ts', join(repo, 'src/app.ts'))
  assert.equal(treeHash(join(repo, 'src/app.ts')), treeHash(join(root, 'outside.ts')), 'root links hash their actual target')
  run('parent-symlink escape cold', { cacheable: false })
  put(join(root, 'outside.ts'), 'changed actual external source\n')
  run('parent-symlink escape changed', { cacheable: false })
  assert.equal(readFileSync(join(installed, 'lib/types/index.js'), 'utf8'), 'changed actual external source\n')
  const linkTree = join(root, 'links')
  put(join(linkTree, 'real'))
  symlinkSync('../repo/AGENTS.md', join(linkTree, 'external'))
  assert.equal(treeHash(linkTree), undefined)
  rmSync(join(linkTree, 'external'))
  symlinkSync('cycle', join(linkTree, 'cycle'))
  assert.equal(treeHash(linkTree), undefined)
  console.log('PASS: external/cyclic links disable reuse with a diagnostic; all fixtures cleaned')
} finally {
  rmSync(root, { recursive: true, force: true })
}
