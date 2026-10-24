/** Generate the private, self-contained profile bundle shipped inside the main package. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, PACKAGE, RUNTIME_BUNDLE } from '../src/dsh-adapter/market/runtime-profile.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (manifest.name !== PACKAGE) throw new Error('Unexpected TUI package name')
const patch = await readFile(join(root, 'cordis.patch.yml'))
const output = join(root, 'lib', 'tui-runtime')
await mkdir(output, { recursive: true })
await writeFile(join(output, 'cordis.patch.yml'), patch)
await writeFile(join(output, 'package.json'), `${JSON.stringify({
  name: RUNTIME_BUNDLE,
  version: manifest.version,
  private: true,
  dependencies: { [PACKAGE]: manifest.version },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dshTui: { patchSha256: digest(patch) },
}, null, 2)}\n`)
