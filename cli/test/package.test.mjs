/** Installed-tarball and standalone-route smoke tests (no npm install/model). */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, copyFile, cp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { c as createTar, x as extractTar } from 'tar'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'dst-package-'))
after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }))

test('standalone extracts and runs the same CLI without initializing its TUI profile', async () => {
  const source = join(temporary, 'archive')
  const tui = join(source, 'node_modules/@deepseek-harness-tui/dsh-tui')
  const host = join(source, 'node_modules/@deepseek-ai/dsh')
  await mkdir(tui, { recursive: true })
  await mkdir(join(host, 'lib'), { recursive: true })
  await cp(join(root, 'cli'), join(tui, 'cli'), { recursive: true, filter: path => !path.includes(`${join('cli', 'test')}`) })
  await copyFile(join(root, 'cli/test/fixtures/dsh.mjs'), join(host, 'lib/bin.js'))
  await writeFile(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(tui, 'cordis.patch.yml'), '[]')
  const standalone = join(temporary, 'standalone')
  await mkdir(standalone)
  await createTar({ gzip: true, cwd: source, file: join(standalone, 'runtime.tar.gz') }, ['node_modules'])
  await copyFile(join(root, 'standalone/cacheGuard.cjs'), join(standalone, 'cacheGuard.cjs'))
  const entry = (await readFile(join(root, 'standalone/entry.mjs'), 'utf8')).replace("from 'tar'", `from '${pathToFileURL(require.resolve('tar')).href}'`)
  await writeFile(join(standalone, 'entry.mjs'), entry)
  const home = join(temporary, 'standalone-home')
  const env = { ...process.env, DSH_HOME: home, DSH_TUI_STANDALONE_CACHE: join(temporary, 'cache'), DSH_TUI_CLI_NODE: process.execPath }
  delete env.DSH_TUI_CLI_DSH_BIN
  delete env.DSH_TUI_CLI_INSTALL_ANCHOR
  const result = spawnSync(process.execPath, [join(standalone, 'entry.mjs'), 'run', 'standalone task', '--json'], {
    cwd: root, input: '', encoding: 'utf8', timeout: 15000, env,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(JSON.parse(result.stdout).text, 'standalone task')
  await assert.rejects(readFile(join(home, 'profiles/dsh-tui/package.json')), { code: 'ENOENT' })
})
