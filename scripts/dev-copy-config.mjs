#!/usr/bin/env node
/** Copy only model settings and credentials into the isolated dev DSH home. */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveDevPaths(
  environment = process.env,
  userHome = homedir(),
  platform = process.platform,
) {
  const pathApi = platform === 'win32' ? win32 : posix
  const defaultCacheRoot = platform === 'win32' && environment.LOCALAPPDATA?.trim()
    ? environment.LOCALAPPDATA.trim()
    : environment.XDG_CACHE_HOME?.trim() || pathApi.join(userHome, '.cache')
  const devRoot = pathApi.resolve(
    environment.DSH_TUI_DEV_ROOT?.trim() || pathApi.join(defaultCacheRoot, 'dsh-tui-dev'),
  )
  const sourceHome = pathApi.resolve(environment.DSH_SOURCE_HOME?.trim() || pathApi.join(userHome, '.dsh'))
  return {
    devRoot,
    sourceHome,
    isolatedHome: pathApi.join(devRoot, 'home'),
    dshHome: pathApi.join(devRoot, 'dsh-home'),
    sessionRoot: pathApi.join(devRoot, 'sessions'),
  }
}

function secureMode(path, mode, platform) {
  if (platform !== 'win32') chmodSync(path, mode)
}

export function copyDevConfig(environment = process.env, platform = process.platform) {
  const paths = resolveDevPaths(environment, homedir(), platform)
  mkdirSync(paths.devRoot, { recursive: true, mode: 0o700 })
  mkdirSync(paths.dshHome, { recursive: true, mode: 0o700 })
  secureMode(paths.devRoot, 0o700, platform)
  secureMode(paths.dshHome, 0o700, platform)

  const copied = []
  for (const file of ['settings.yaml', '.credentials.yaml']) {
    const source = join(paths.sourceHome, file)
    if (!existsSync(source)) continue
    const target = join(paths.dshHome, file)
    copyFileSync(source, target)
    secureMode(target, 0o600, platform)
    copied.push(file)
  }
  return { ...paths, copied }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = copyDevConfig()
    console.log(`dev-copy-config: ${result.copied.length > 0 ? result.copied.join(', ') : 'no source files found'}`)
    console.log(`  source:   ${result.sourceHome}`)
    console.log(`  DSH_HOME: ${result.dshHome}`)
  } catch (error) {
    console.error(`dev-copy-config: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
