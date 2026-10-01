/**
 * doctor 配置候选项回归：CLI（`dsh-tui doctor`）与 TUI 内 `/doctor` 必须对同一份
 * 磁盘状态给出同一组候选路径——「两个 doctor 不许分叉」是两侧代码注释里的契约，
 * 此前没有任何脚本钉住它。
 *
 * 覆盖：
 *   A. 两者都不存在：只有 profile 补丁一条 config 行，legacy 根配置不出现（两侧
 *      一致，且都不带 ✓）；
 *   B. 用户保留了 legacy 根配置：两侧都列出它并标 ✓，config 行两条；
 *   C. profile 补丁存在：两侧都标 ✓；
 *   D. `$DSH_HOME` 不是 `~/.dsh`：profile 补丁行落在 `$DSH_HOME` 下，两侧都不再
 *      出现写死的 `~/.dsh/profiles/dsh-tui/...`。
 *
 * 背景见 `bin/dsh-tui.js` 的 runDoctorChecks 与 `src/dsh-adapter/channel/reports.ts`
 * 的 doctorInfo 注释：`~/.dsh-tui/cordis.yml` 是裸组合（`dsh --config cordis.yml`）
 * 时代的用户根配置，profile 安装不使用它、全包也没有代码读它。
 *
 * HOME/USERPROFILE/DSH_HOME 在导入 src 之前隔离（本脚本经 tsx 直接 import 源码）。
 * 运行：node --import tsx/esm scripts/verify-doctor-config-paths.ts
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'bin', 'dsh-tui.js')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-doctor-config-'))
const userHome = join(tmp, 'user-home')
const dshHome = join(tmp, 'dsh-home')
mkdirSync(userHome, { recursive: true })
mkdirSync(dshHome, { recursive: true })

// 隔离先于任何 src 导入：语言按 DSH_TUI_LANG 解析，data dir 也在 import 时求值。
process.env.HOME = userHome
process.env.USERPROFILE = userHome
process.env.DSH_HOME = dshHome
process.env.DSH_TUI_LANG = 'zh'

const legacyConfig = join(userHome, '.dsh-tui', 'cordis.yml')
const profileConfig = join(dshHome, 'profiles', 'dsh-tui', 'cordis.patch.yml')
const hardcodedProfileConfig = join(userHome, '.dsh', 'profiles', 'dsh-tui', 'cordis.patch.yml')

const { createReportActions } = await import('../src/dsh-adapter/channel/reports.js')

const reportActions = createReportActions({ get: () => undefined } as never, {
  owner: { current: () => true },
  capture: () => ({ agent: { id: 'doctor-config-agent', session: { events: [] } } as never, generation: 1 }),
  current: () => true,
  cwd: () => userHome,
  model: () => 'doctor-config-model',
  provider: () => 'doctor-config-provider',
  contextWindow: () => undefined,
  sessionTitle: () => '',
  runtime: {} as never,
  grantStore: () => ({ grants: {}, denies: {} }) as never,
})

let checks = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

const cliLines = (): string[] => {
  const probe = spawnSync(process.execPath, [bin, 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome, DSH_HOME: dshHome, DSH_TUI_LANG: 'zh' },
  })
  return String(probe.stdout ?? '').split('\n').filter(line => line !== '')
}
const tuiLines = (): string[] => reportActions.doctorInfo()
// CLI 侧是 `[✓✗] config: <path>`；TUI 侧是 `配置: <path> [✓|（不存在）]`。
const isConfigLine = (line: string): boolean => line.includes(' config: ') || line.includes('配置: ')
const marked = (line: string): boolean => line.trimEnd().endsWith('✓')

const expectConfigs = (side: string, lines: string[], expected: string[]): string[] => {
  const configs = lines.filter(isConfigLine)
  check(`${side}: ${expected.length} 条 config 行`, configs.length === expected.length, configs.join(' | '))
  for (const path of expected) {
    check(`${side}: config 行列出 ${path}`, configs.some(line => line.includes(path)), configs.join(' | '))
  }
  return configs
}
const expectNoHardcoded = (side: string, lines: string[]): void => {
  check(
    `${side}: 不再指向写死的 ~/.dsh/profiles/dsh-tui/cordis.patch.yml`,
    !lines.some(line => line.includes(hardcodedProfileConfig)),
    lines.filter(line => line.includes('cordis.patch.yml')).join(' | '),
  )
}

// ── A. 两个候选都不存在（正常 profile 安装的默认形态）────────────────────────
{
  const cli = cliLines()
  const tui = tuiLines()
  const cliConfigs = expectConfigs('CLI', cli, [profileConfig])
  const tuiConfigs = expectConfigs('TUI', tui, [profileConfig])
  check(
    'CLI: legacy 根配置缺席时不再作为候选出现',
    !cli.some(line => isConfigLine(line) && line.includes(legacyConfig)),
    cliConfigs.join(' | '),
  )
  check(
    'TUI: legacy 根配置缺席时不再作为候选出现',
    !tui.some(line => isConfigLine(line) && line.includes(legacyConfig)),
    tuiConfigs.join(' | '),
  )
  check('两侧对缺席的 profile 补丁判定一致（都不带 ✓）',
    cliConfigs.every(line => !line.startsWith('✓')) && tuiConfigs.every(line => !marked(line)),
    `${cliConfigs.join(' | ')}  ::  ${tuiConfigs.join(' | ')}`)
  expectNoHardcoded('CLI', cli)
  expectNoHardcoded('TUI', tui)
}

// ── B. 用户保留了 legacy 根配置：存在才出现，且是 ✓ ──────────────────────────
{
  mkdirSync(dirname(legacyConfig), { recursive: true })
  writeFileSync(legacyConfig, '[]')
  const cli = cliLines()
  const tui = tuiLines()
  const cliConfigs = expectConfigs('CLI', cli, [legacyConfig, profileConfig])
  const tuiConfigs = expectConfigs('TUI', tui, [legacyConfig, profileConfig])
  check(
    'CLI: legacy 根配置以 ✓ 列出',
    cliConfigs.some(line => line.startsWith('✓') && line.includes(legacyConfig)),
    cliConfigs.join(' | '),
  )
  check(
    'TUI: legacy 根配置以 ✓ 列出',
    tuiConfigs.some(line => marked(line) && line.includes(legacyConfig)),
    tuiConfigs.join(' | '),
  )
}

// ── C. profile 补丁存在：两侧都标 ✓ ──────────────────────────────────────────
{
  mkdirSync(dirname(profileConfig), { recursive: true })
  writeFileSync(profileConfig, '[]')
  const cli = cliLines()
  const tui = tuiLines()
  const cliConfigs = expectConfigs('CLI', cli, [legacyConfig, profileConfig])
  const tuiConfigs = expectConfigs('TUI', tui, [legacyConfig, profileConfig])
  check(
    'CLI: profile 补丁以 ✓ 列出',
    cliConfigs.some(line => line.startsWith('✓') && line.includes(profileConfig)),
    cliConfigs.join(' | '),
  )
  check(
    'TUI: profile 补丁以 ✓ 列出',
    tuiConfigs.some(line => marked(line) && line.includes(profileConfig)),
    tuiConfigs.join(' | '),
  )
  check('两侧的 config 候选集合完全相同',
    cliConfigs.length === tuiConfigs.length &&
      [legacyConfig, profileConfig].every(path => cliConfigs.some(line => line.includes(path)) && tuiConfigs.some(line => line.includes(path))),
    `${cliConfigs.join(' | ')}  ::  ${tuiConfigs.join(' | ')}`)
}

rmSync(tmp, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`doctor-config-paths FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`doctor-config-paths OK (${checks} checks: legacy 根配置只在存在时出现、profile 补丁跟随 $DSH_HOME、两侧候选一致)`)
process.exit(0)
