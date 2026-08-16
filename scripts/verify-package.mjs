import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const packageDir = await mkdtemp(join(tmpdir(), 'dsh-tui-pack-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  const result = spawnSync(
    npm,
    ['pack', '--json', '--pack-destination', packageDir],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }

  const report = JSON.parse(result.stdout)
  const files = new Set(report[0]?.files?.map(({ path }) => path))
  const requiredFiles = [
    'lib/types/index.js',
    'lib/types/index.d.ts',
    'lib/invariant.js',
  ]
  const missingFiles = requiredFiles.filter((path) => !files.has(path))

  if (missingFiles.length > 0) {
    throw new Error(`npm package is missing: ${missingFiles.join(', ')}`)
  }

  console.log(`Verified npm package contents (${files.size} files).`)
} finally {
  await rm(packageDir, { force: true, recursive: true })
}
