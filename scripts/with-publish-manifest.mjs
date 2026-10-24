import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { commandInvocation } from './dev-command.mjs'
import { publishManifest } from './publish-manifest.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const [command, ...args] = process.argv.slice(2)
if (command !== 'npm' || !['pack', 'publish'].includes(args[0])) {
  throw new Error('usage: node with-publish-manifest.mjs npm <pack|publish> [args...]')
}
const manifest = await publishManifest(JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')), projectRoot)
// Never rewrite the checkout manifest: pnpm may check it from another process.
const staging = await mkdtemp(join(tmpdir(), 'dsh-tui-publish-'))
try {
  const files = new Set(manifest.files.filter(path => !path.startsWith('!')).map(path => {
    const wildcard = path.indexOf('*')
    const prefix = path.slice(0, wildcard)
    return wildcard < 0 ? path : prefix.endsWith('/') ? prefix.slice(0, -1) : dirname(prefix)
  }))
  for (const name of await readdir(projectRoot)) {
    if (/^(?:README|LICENSE|LICENCE|COPYING|CHANGELOG)(?:\.|$)/iu.test(name)) files.add(name)
  }
  for (const path of files) {
    await mkdir(dirname(join(staging, path)), { recursive: true })
    await cp(join(projectRoot, path), join(staging, path), { recursive: true })
  }
  // Physical copies keep npm's bundle walker inside staging. Linking the whole
  // node_modules directory can emit ../ paths for nested workspace symlinks.
  for (const name of manifest.bundledDependencies) {
    const target = join(staging, 'node_modules', ...name.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await cp(await realpath(join(projectRoot, 'node_modules', ...name.split('/'))), target, {
      recursive: true, dereference: true,
      filter: path => !['node_modules', '.git'].includes(path.split(/[\\/]/u).at(-1)),
    })
  }
  await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const npmArgs = [...args]
  if (!npmArgs.includes('--ignore-scripts')) npmArgs.push('--ignore-scripts')
  if (args[0] === 'pack') {
    let destination = false
    for (let i = 1; i < npmArgs.length; i++) {
      if (npmArgs[i] === '--pack-destination') {
        npmArgs[i + 1] = resolve(projectRoot, npmArgs[i + 1])
        destination = true
        i++
      } else if (npmArgs[i].startsWith('--pack-destination=')) {
        npmArgs[i] = `--pack-destination=${resolve(projectRoot, npmArgs[i].slice('--pack-destination='.length))}`
        destination = true
      }
    }
    if (!destination) npmArgs.push('--pack-destination', projectRoot)
  }
  const [executable, invocationArgs] = commandInvocation(command, npmArgs)
  const result = spawnSync(executable, invocationArgs, {
    cwd: staging, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status === 0 && args[0] === 'pack' && args.includes('--json')) {
    const reports = JSON.parse(result.stdout)
    const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
    // npm runs here with scripts disabled, so this is the exact manifest used
    // for the reported package, including dry runs. Read it before cleanup.
    report.dshTuiManifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
    process.stdout.write(`${JSON.stringify(reports)}\n`)
  } else if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { await rm(staging, { recursive: true, force: true }) }
