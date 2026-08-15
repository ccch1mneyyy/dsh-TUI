#!/usr/bin/env node
/**
 * verify-legacy-rename.mjs — issue #120 换名迁移回归（CC_TUI_*、DSH_CC_*
 * 前缀 → DSH_TUI_*，数据目录 ~/.dsh-cc → ~/.dsh-tui）。全程临时目录/注入
 * env，不碰真实 home。覆盖三件事：
 *   1. migrateLegacyDataDir：旧存新不存才复制（复制而非移动，旧目录保留），
 *      target 已存在时幂等返回 false；
 *   2. resume.txt 双写契约：编译产物 lib/types/sessionHistory.js 同时引用
 *      新（~/.dsh-tui）与旧（~/.dsh-cc）两个 resume 路径——目录不可注入，
 *      像 verify-update.mjs 那样对编译产物做文本断言；
 *   3. detectLegacyEnv：只报 RENAMED_ENV 里的旧名——DSH_CC_RESUME_SESSION
 *      是双读双写契约的合法一半，不得报；RENAMED_ENV 的新名全部 DSH_TUI_
 *      开头。
 *
 * 运行：pnpm build && node scripts/verify-legacy-rename.mjs
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

// paths.js 模块级常量（DATA_DIR 等）解析真实 home，但下面全部通过参数注入
// 目录/env，真实 home 只被读取路径字符串、绝不落盘。
const { migrateLegacyDataDir, detectLegacyEnv, RENAMED_ENV } = await import('../lib/types/utils/paths.js')

// --- 1. migrateLegacyDataDir：首启复制迁移 ----------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'verify-legacy-rename-'))
const legacy = join(tmp, '.dsh-cc')
const target = join(tmp, '.dsh-tui')
mkdirSync(join(legacy, 'themes'), { recursive: true })
writeFileSync(join(legacy, 'theme.json'), '{"theme":"dark"}')
writeFileSync(join(legacy, 'themes', 'sakura.json'), '{"base":"dark","colors":{}}')

check('migrate: first call copies legacy → target', migrateLegacyDataDir(legacy, target) === true)
check(
  'migrate: target content matches legacy',
  readFileSync(join(target, 'theme.json'), 'utf8') === '{"theme":"dark"}'
    && readFileSync(join(target, 'themes', 'sakura.json'), 'utf8') === '{"base":"dark","colors":{}}',
)
check('migrate: legacy dir preserved (copy, not move)', existsSync(join(legacy, 'theme.json')))
check('migrate: second call is a no-op (target exists)', migrateLegacyDataDir(legacy, target) === false)
check('migrate: missing legacy is a no-op', migrateLegacyDataDir(join(tmp, 'no-such-dir'), join(tmp, 'other')) === false)

// --- 2. resume.txt 双写契约（编译产物文本断言） ------------------------------
const history = readFileSync(join(root, 'lib', 'types', 'sessionHistory.js'), 'utf8')
check('resume dual-write: new path ~/.dsh-tui referenced', history.includes('.dsh-tui'))
check('resume dual-write: legacy path ~/.dsh-cc referenced', history.includes('.dsh-cc'))
check('resume dual-write: both RESUME_FILE and LEGACY_RESUME_FILE wired', history.includes('RESUME_FILE') && history.includes('LEGACY_RESUME_FILE'))

// --- 3. detectLegacyEnv / RENAMED_ENV ---------------------------------------
const found = detectLegacyEnv({
  CC_TUI_THEME: 'dark',
  DSH_CC_SESSION_ROOT: join(tmp, 'sessions'),
  DSH_CC_RESUME_SESSION: '00000000-1111-2222-3333-444444444444', // 双读契约的合法一半
  DSH_TUI_THEME: 'dark', // 新名，不是废弃名
})
check('detectLegacyEnv: reports CC_TUI_THEME', found.includes('CC_TUI_THEME'))
check('detectLegacyEnv: reports DSH_CC_SESSION_ROOT', found.includes('DSH_CC_SESSION_ROOT'))
check('detectLegacyEnv: DSH_CC_RESUME_SESSION not reported (dual-read contract)', !found.includes('DSH_CC_RESUME_SESSION'))
check('detectLegacyEnv: new names not reported', !found.includes('DSH_TUI_THEME'))
check('RENAMED_ENV: CC_TUI_THEME → DSH_TUI_THEME', RENAMED_ENV.CC_TUI_THEME === 'DSH_TUI_THEME')
check('RENAMED_ENV: DSH_CC_SESSION_ROOT → DSH_TUI_SESSION_ROOT', RENAMED_ENV.DSH_CC_SESSION_ROOT === 'DSH_TUI_SESSION_ROOT')
check('RENAMED_ENV: every new name starts with DSH_TUI_', Object.values(RENAMED_ENV).every(name => name.startsWith('DSH_TUI_')))

rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`verify-legacy-rename: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-legacy-rename: OK ✅')
