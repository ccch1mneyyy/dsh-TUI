import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtime = '@runtime@/lib/dsh-tui/node_modules'
const node = '@node@/bin/node'
const binDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../bin')
process.env.PATH = [binDirectory, '@node@/bin', '@pnpm@/bin', '@coreutils@/bin', process.env.PATH ?? ''].join(':')
process.env.DSH_HOME ||= join(homedir(), '.dsh-tui-nix')
const entry = join(runtime, '@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js')
const readOnlyCommand = ['help', '--help', '-h', 'version', '--version', '-v'].includes(process.argv[2])

if (!readOnlyCommand) {
  const profile = join(resolve(process.env.DSH_HOME), 'profiles', 'dsh-tui')
  const marker = join(profile, '.nix-managed')
  const modules = join(profile, 'node_modules')
  mkdirSync(profile, { recursive: true })
  if (!existsSync(marker)) {
    if (readdirSync(profile).length !== 0) {
      throw new Error(`Refusing to replace an existing unmanaged profile at ${profile}. Use a separate DSH_HOME for the Nix installation.`)
    }
    writeFileSync(marker, '1\n', { flag: 'wx' })
  }
  if (readFileSync(marker, 'utf8') !== '1\n') throw new Error(`Invalid Nix profile marker at ${marker}`)
  const existing = lstatSync(modules, { throwIfNoEntry: false })
  if (existing !== undefined && (!existing.isSymbolicLink() || !/^\/nix\/store\/[^/]+-dsh-tui-runtime-[^/]+\/lib\/dsh-tui\/node_modules$/.test(readlinkSync(modules)))) {
    throw new Error(`Refusing to replace unmanaged node_modules at ${modules}`)
  }
  if (existing === undefined || readlinkSync(modules) !== runtime) {
    const temporary = `${modules}.${process.pid}`
    symlinkSync(runtime, temporary)
    renameSync(temporary, modules)
  }
  const manifest = join(profile, 'package.json')
  const version = JSON.parse(readFileSync(join(runtime, '@deepseek-harness-tui/dsh-tui/package.json'), 'utf8')).version
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({
      name: 'dsh-profile-dsh-tui-nix',
      private: true,
      dependencies: { '@deepseek-harness-tui/dsh-tui': version },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'] } },
    }, null, 2) + '\n', { flag: 'wx' })
  } else {
    const current = JSON.parse(readFileSync(manifest, 'utf8'))
    current.dependencies = { ...current.dependencies, '@deepseek-harness-tui/dsh-tui': version }
    writeFileSync(manifest, JSON.stringify(current, null, 2) + '\n')
  }
  const patch = join(profile, 'cordis.patch.yml')
  if (!existsSync(patch)) writeFileSync(patch, '[]\n', { flag: 'wx' })
}

process.env.DSH_TUI_CLI_NODE = node
process.argv[1] = entry
await import(pathToFileURL(entry).href)
