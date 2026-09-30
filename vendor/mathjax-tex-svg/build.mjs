// Bundle src/entry.mjs into lib/index.mjs. Legal comments from the bundled
// sources are kept in a separate file next to the bundle (see NOTICE).
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

mkdirSync(new URL('./lib/', import.meta.url), { recursive: true })
const result = await build({
  entryPoints: [fileURLToPath(new URL('./src/entry.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('./lib/index.mjs', import.meta.url)),
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'linked',
  metafile: true,
  logLevel: 'warning',
})
const packages = new Set()
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(input)
  if (match) packages.add(match[1])
}
writeFileSync(new URL('./lib/bundled-packages.json', import.meta.url), JSON.stringify([...packages].sort(), null, 2) + '\n')
