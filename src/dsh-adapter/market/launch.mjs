/** Select the installed release's bootstrap without retaining an old wrapper in argv. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageDirectory, readJson } from './runtime-profile.mjs'

export function managedLaunchArgs(argv, profileDir) {
  const root = packageDirectory(profileDir)
  if (readJson(join(root, 'package.json'))?.dshTui?.runtimeBundle === undefined) return undefined
  const bootstrap = join(root, 'src/dsh-adapter/market/startup.mjs')
  if (!existsSync(bootstrap)) throw new Error('The managed TUI startup bootstrap is missing; repair the installed package')
  const preload = pathToFileURL(bootstrap)
  preload.searchParams.set('profileDir', profileDir)
  return ['--import', preload.href, ...argv]
}
