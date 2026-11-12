/** Publishing must normalize physical bundled manifests and restore workspace links. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const source = fileURLToPath(new URL('../', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'dsh-publish-bundles-'))
const names = ['command', 'connection', 'core', 'manifest', 'messages', 'presentation', 'storage']
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const manifest = { name: 'publish-bundle-fixture', version: '1.0.0', private: true, type: 'module', files: ['index.js'], main: 'index.js', dependencies: {}, bundledDependencies: names.map(name => `@dsh-std/${name}`) }
for (const name of names) {
  const dir = join(root, 'vendor/dsh-std/packages', name)
  const pkg = { name: `@dsh-std/${name}`, version: '0.1.0', type: 'module', main: 'lib/index.js', files: ['lib'], dependencies: name === 'core' ? {} : { '@dsh-std/core': 'workspace:*' } }
  if (name === 'command') pkg.dependencies['@dsh-std/connection'] = 'workspace:*'
  put(join(dir, 'package.json'), JSON.stringify(pkg))
  put(join(dir, 'lib/index.js'), 'export const value = 42\n')
  mkdirSync(join(root, 'node_modules/@dsh-std'), { recursive: true })
  symlinkSync(dir, join(root, 'node_modules/@dsh-std', name), process.platform === 'win32' ? 'junction' : 'dir')
  manifest.dependencies[pkg.name] = 'workspace:*'
}
const nested = join(root, 'vendor/dsh-std/packages/command/node_modules/@dsh-std/connection')
mkdirSync(dirname(nested), { recursive: true })
symlinkSync(join(root, 'vendor/dsh-std/packages/connection'), nested, process.platform === 'win32' ? 'junction' : 'dir')
const nestedLink = readlinkSync(nested)
const math = join(root, 'vendor/mathjax-tex-svg')
put(join(math, 'package.json'), JSON.stringify({ name: '@dsh-tui-vendor/mathjax-tex-svg', version: '0.1.0' }))
put(join(root, 'package.json'), JSON.stringify(manifest))
put(join(root, 'index.js'), "export { value } from '@dsh-std/command'\n")
mkdirSync(join(root, 'scripts/lib'), { recursive: true })
cpSync(join(source, 'scripts/with-publish-manifest.mjs'), join(root, 'scripts/with-publish-manifest.mjs'))
if (existsSync(join(source, 'scripts/lib/publish-bundles.mjs'))) cpSync(join(source, 'scripts/lib/publish-bundles.mjs'), join(root, 'scripts/lib/publish-bundles.mjs'))
const originals = new Map(names.map(name => [name, readFileSync(join(root, 'vendor/dsh-std/packages', name, 'package.json'))]))
const links = new Map(names.map(name => [name, readlinkSync(join(root, 'node_modules/@dsh-std', name))]))
const original = readFileSync(join(root, 'package.json'))
const checkRestored = () => {
  assert.deepEqual(readFileSync(join(root, 'package.json')), original)
  assert.equal(readlinkSync(nested), nestedLink, 'nested workspace source link stays unchanged')
  for (const name of names) {
    assert.equal(readlinkSync(join(root, 'node_modules/@dsh-std', name)), links.get(name))
    assert.deepEqual(readFileSync(join(root, 'vendor/dsh-std/packages', name, 'package.json')), originals.get(name), 'vendor source stays byte-identical')
  }
}
const child = join(root, 'inspect.mjs')
put(child, `import assert from 'node:assert/strict'; import {readFileSync,lstatSync,existsSync} from 'node:fs';
for (const name of ${JSON.stringify(names)}) {
 const dir='node_modules/@dsh-std/'+name;
 assert.equal(lstatSync(dir).isSymbolicLink(),false,'packing uses an isolated physical copy');
 assert.equal(existsSync(dir+'/node_modules'),false,'workspace-local dependency trees are not copied');
 const manifest=JSON.parse(readFileSync(dir+'/package.json'));
 for (const range of Object.values(manifest.dependencies??{})) assert.equal(range,'0.1.0');
}
process.exit(Number(process.argv[2]??0));\n`)
const run = args => spawnSync(process.execPath, [join(root, 'scripts/with-publish-manifest.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 30000 })
try {
  const success = run([process.execPath, child])
  assert.equal(success.status, 0, success.stderr)
  checkRestored()
  const failure = run([process.execPath, child, '17'])
  assert.equal(failure.status, 17, failure.stderr)
  checkRestored()
  if (process.platform !== 'win32') {
    const ready = join(root, 'signal-ready')
    const waiting = join(root, 'waiting.mjs')
    put(waiting, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`)
    const signalChild = spawn(process.execPath, [join(root, 'scripts/with-publish-manifest.mjs'), process.execPath, waiting], { cwd: root, stdio: 'ignore' })
    const ended = new Promise(resolve => signalChild.once('close', (code, signal) => resolve({ code, signal })))
    try {
      const until = Date.now() + 5000
      while (!existsSync(ready)) { assert.ok(Date.now() < until, 'signal child started'); await new Promise(resolve => setTimeout(resolve, 10)) }
      signalChild.kill('SIGTERM')
      assert.deepEqual(await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('signal cleanup timeout')), 5000).unref())]), { code: null, signal: 'SIGTERM' })
      checkRestored()
    } finally { signalChild.kill('SIGKILL') }
  }
  const missing = run([join(root, 'nonexistent-executable')])
  assert.notEqual(missing.status, 0)
  checkRestored()
  // Unknown workspace protocols fail without rewriting the vendor source or stranding a link.
  const target = join(root, 'vendor/dsh-std/packages/command/package.json')
  const changed = JSON.parse(readFileSync(target)); changed.dependencies['@dsh-std/core'] = 'workspace:^'
  writeFileSync(target, JSON.stringify(changed))
  const invalid = run([process.execPath, '-e', 'process.exit(0)'])
  assert.notEqual(invalid.status, 0, 'unsupported workspace protocol must fail closed')
  writeFileSync(target, originals.get('command'))
  checkRestored()
  console.log('publish bundle staging: normalized manifests, untouched vendor, and success/failure restoration OK')
} finally { rmSync(root, { recursive: true, force: true }) }
