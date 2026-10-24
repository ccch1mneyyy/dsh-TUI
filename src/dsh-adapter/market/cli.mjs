/** Prepare the launcher profile using the installed host, without booting DSH. */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareInstalledRuntime } from './prepare.mjs'
import { PACKAGE, PROFILE, readJson, runtimeStatus, runtimeTemplate } from './runtime-profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const profile = process.argv[2] ?? PROFILE
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const english = process.env.DSH_TUI_LANG === 'en'
try {
  if (!runtimeStatus(join(home, 'profiles', profile)).ready) {
    const version = readJson(join(root, 'package.json'))?.version ?? 'latest'
    let modules
    try {
      runtimeTemplate(root)
      modules = await import(pathToFileURL(join(root, 'lib/types/dsh-adapter/host-dsh.js')).href)
    } catch (error) {
      const command = `dsh plugin --profile ${profile} add -w --force ${PACKAGE}@${version}`
      throw new Error(english
        ? `The compiled TUI runtime is missing or cannot be loaded (${error.message}).\n  ${root}\nInstall the matching published package:\n  ${command}\nFor a source checkout, run pnpm install --frozen-lockfile and pnpm compile in that checkout.`
        : `TUI 编译产物缺失或无法加载（${error.message}）。\n  ${root}\n请安装同版本的已发布包：\n  ${command}\n若使用源码，请在源码目录运行 pnpm install --frozen-lockfile 和 pnpm compile。`)
    }
    const found = modules.findHostDsh()
    if (found.packageDir !== undefined) {
      let host
      try { host = await modules.loadHostProfileManagement(found.packageDir) }
      catch { /* The launcher still owns unavailable-host fallback for each backend. */ }
      if (host !== undefined) {
        await prepareInstalledRuntime({
          ...host,
          source: { home, cwd: process.cwd(), installAnchor: join(found.packageDir, 'package.json') },
          version, profile,
        })
      }
    }
  }
} catch (error) {
  console.error(english
    ? `[dsh-tui] TUI profile preparation failed: ${error.message}\nRun dsh-tui safe for diagnostics and repair guidance.`
    : `[dsh-tui] TUI profile 准备失败：${error.message}\n可运行 dsh-tui safe 查看诊断和修复指引。`)
  process.exitCode = 1
}
