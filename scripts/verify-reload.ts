/**
 * verify-reload — /reload 与 /restart 的纯函数回归。
 *
 * 覆盖 src/reload.ts 的 planReload（pi 式软重载决策）与两个命令在
 * src/commands.ts 的注册：
 *   1. 五类偏好（theme/lang/preset/model/activity）在无显式配置时的应用
 *      与顺序；
 *   2. 优先级守卫：DSH_TUI_THEME / DSH_TUI_LANG（env-wins）、cordis.yml
 *      显式 preset / lang / activityFrames / 完整 provider+model 对
 *      （config-wins）、settings 用户层 lang（config-wins）；
 *   3. 原子路由规则（issue #67）：provider-only pin 不得阻止偏好生效；
 *   4. 无效/缺失偏好文件（invalid）与无变化（unchanged）分支；
 *   5. 命令注册：/reload、/restart 在 LOCAL_COMMANDS 中、isLocalCommandName
 *      识别、parseCommandName 拆分。
 *
 * 运行：node --import tsx/esm scripts/verify-reload.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planReload, type ReloadPlan } from '../src/reload.js'
import { LOCAL_COMMANDS, isLocalCommandName, parseCommandName } from '../src/commands.js'
import { migratePresetPref, parsePresetPref, readPresetPref, writePresetPref } from '../src/presetPrefs.js'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** Count plan entries by bucket. */
function counts(plan: ReloadPlan): { apply: number; unchanged: number; skipped: number } {
  return { apply: plan.apply.length, unchanged: plan.unchanged.length, skipped: plan.skipped.length }
}

const BASE = {
  envTheme: undefined,
  envLang: undefined,
  themePref: 'dark',
  currentTheme: 'dark',
  langPref: 'zh' as const,
  currentLang: 'zh',
  langOverriddenBySettings: false,
  configuredLang: undefined,
  configuredPreset: undefined,
  presetPref: 'standard',
  currentPreset: 'standard',
  configuredModel: undefined,
  modelPref: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  currentModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  configuredActivity: undefined,
  activityPref: 'claude',
  currentActivity: 'claude',
}

// ── 1. 全部无变化 → 全 unchanged，零 apply/skip ─────────────────────────
{
  const plan = planReload(BASE)
  check('全部匹配 → unchanged=5', counts(plan).unchanged === 5, `got ${counts(plan).unchanged}`)
  check('全部匹配 → apply=0 skipped=0', counts(plan).apply === 0 && counts(plan).skipped === 0)
  check('unchanged 顺序', JSON.stringify(plan.unchanged) === JSON.stringify(['theme', 'lang', 'preset', 'model', 'activity']), JSON.stringify(plan.unchanged))
}

// ── 2. 五项都改 → 五项都 apply，顺序固定 ────────────────────────────────
{
  const plan = planReload({
    ...BASE,
    themePref: 'light',
    langPref: 'en',
    presetPref: 'ptc',
    modelPref: { provider: 'deepseek', model: 'deepseek-chat' },
    activityPref: 'moon',
  })
  check('全改 → apply=5', counts(plan).apply === 5, `got ${counts(plan).apply}`)
  check('apply 顺序', JSON.stringify(plan.apply.map(a => a.kind)) === JSON.stringify(['theme', 'lang', 'preset', 'model', 'activity']), JSON.stringify(plan.apply.map(a => a.kind)))
  const model = plan.apply.find(a => a.kind === 'model')
  check('model apply 携带完整路由', model?.route?.provider === 'deepseek' && model?.route?.model === 'deepseek-chat')
  check('model from/to 渲染', model?.from === 'deepseek-official/deepseek-v4-flash' && model?.to === 'deepseek/deepseek-chat', `${model?.from} → ${model?.to}`)
  check('theme from/to', plan.apply[0]?.from === 'dark' && plan.apply[0]?.to === 'light')
}

// ── 3. theme：env 优先 / 无效 / 缺文件 ──────────────────────────────────
{
  const plan = planReload({ ...BASE, envTheme: 'light', themePref: 'light' })
  check('theme env 优先 → skip env-wins', plan.skipped.some(s => s.kind === 'theme' && s.reason === 'env-wins'), JSON.stringify(plan.skipped))
  check('theme env 优先 → 不 apply', !plan.apply.some(a => a.kind === 'theme'))
  const noFile = planReload({ ...BASE, themePref: undefined })
  check('theme 无文件 → skip invalid', noFile.skipped.some(s => s.kind === 'theme' && s.reason === 'invalid'))
}

// ── 4. lang：env / settings 用户层 / cordis.yml 三级优先 ────────────────
{
  const env = planReload({ ...BASE, envLang: 'en', langPref: 'zh' })
  check('lang env 优先 → skip env-wins', env.skipped.some(s => s.kind === 'lang' && s.reason === 'env-wins'))
  const settings = planReload({ ...BASE, langOverriddenBySettings: true, langPref: 'en' })
  check('lang settings 用户层 → skip config-wins', settings.skipped.some(s => s.kind === 'lang' && s.reason === 'config-wins'))
  const cordis = planReload({ ...BASE, configuredLang: 'zh', langPref: 'en' })
  check('lang cordis.yml → skip config-wins', cordis.skipped.some(s => s.kind === 'lang' && s.reason === 'config-wins'))
  const changed = planReload({ ...BASE, langPref: 'en' })
  check('lang 变化 → apply en', changed.apply.some(a => a.kind === 'lang' && a.to === 'en' && a.from === 'zh'))
  const noFile = planReload({ ...BASE, langPref: undefined })
  check('lang 无文件 → skip invalid', noFile.skipped.some(s => s.kind === 'lang' && s.reason === 'invalid'))
}

// ── 5. preset / activity：cordis.yml 显式优先 ───────────────────────────
{
  const preset = planReload({ ...BASE, configuredPreset: 'ptc', presetPref: 'standard' })
  check('preset cordis.yml → skip config-wins', preset.skipped.some(s => s.kind === 'preset' && s.reason === 'config-wins'))
  const presetApply = planReload({ ...BASE, presetPref: 'ptc' })
  check('preset 变化 → apply', presetApply.apply.some(a => a.kind === 'preset' && a.to === 'ptc'))
  const presetNoFile = planReload({ ...BASE, presetPref: undefined })
  check('preset 无文件 → skip invalid', presetNoFile.skipped.some(s => s.kind === 'preset' && s.reason === 'invalid'))
  const activity = planReload({ ...BASE, configuredActivity: 'moon', activityPref: 'claude' })
  check('activity cordis.yml → skip config-wins', activity.skipped.some(s => s.kind === 'activity' && s.reason === 'config-wins'))
  const activityApply = planReload({ ...BASE, activityPref: 'moon' })
  check('activity 变化 → apply', activityApply.apply.some(a => a.kind === 'activity' && a.to === 'moon'))
}

// ── 6. model：完整 pair 优先；provider-only pin 不挡偏好（原子规则） ────
{
  const complete = planReload({
    ...BASE,
    configuredModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    modelPref: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  check('model 完整 pair → skip config-wins', complete.skipped.some(s => s.kind === 'model' && s.reason === 'config-wins'))
  check('model 完整 pair → 不 apply', !complete.apply.some(a => a.kind === 'model'))
  // issue #67 原子规则：只 pin provider 不算显式路由，不得阻止偏好生效。
  const half = planReload({
    ...BASE,
    configuredModel: { provider: 'deepseek-official', model: undefined },
    modelPref: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  check('model provider-only pin 不挡偏好 → apply', half.apply.some(a => a.kind === 'model' && a.route?.provider === 'deepseek'), JSON.stringify(half.skipped))
  check('model provider-only pin → 无 skip', !half.skipped.some(s => s.kind === 'model'))
  const noFile = planReload({ ...BASE, modelPref: undefined })
  check('model 无文件 → skip invalid', noFile.skipped.some(s => s.kind === 'model' && s.reason === 'invalid'))
  const noCurrent = planReload({ ...BASE, currentModel: undefined, modelPref: { provider: 'deepseek', model: 'deepseek-chat' } })
  check('model 无当前路由仍 apply', noCurrent.apply.some(a => a.kind === 'model' && a.from === '—'))
}

// ── 7. legacy code preset：名册解析后才迁移（rc 仍以 code 为真名） ─────
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-preset-pref-'))
  const file = join(dir, 'agent-preset.json')
  try {
    writeFileSync(file, JSON.stringify({ preset: 'code' }))
    check('无名册时旧 preset JSON 保持 code', parsePresetPref(readFileSync(file, 'utf8')) === 'code')
    check('无名册时读取旧 preset 保持 code', readPresetPref(dir) === 'code')
    check('读取本身不做不可逆改写', JSON.parse(readFileSync(file, 'utf8')).preset === 'code')
    check('0.1.2 名册解析后迁移为 ptc', migratePresetPref('code', 'ptc', dir) && JSON.parse(readFileSync(file, 'utf8')).preset === 'ptc')
    check('rc 写入 code 仍保存 code', writePresetPref('code', dir) && JSON.parse(readFileSync(file, 'utf8')).preset === 'code')
    check('自定义 preset id 保持不变', parsePresetPref(JSON.stringify({ preset: 'liangshen' })) === 'liangshen')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 8. 命令注册：/reload、/restart ──────────────────────────────────────
{
  const names = LOCAL_COMMANDS.map(c => c.name)
  check('/reload 已注册', names.includes('reload'))
  check('/restart 已注册', names.includes('restart'))
  check('/reload 被 isLocalCommandName 识别', isLocalCommandName('/reload'))
  check('/restart 被 isLocalCommandName 识别', isLocalCommandName('/restart'))
  check('/reload 描述非空', LOCAL_COMMANDS.find(c => c.name === 'reload')?.description.length > 0)
  const parsed = parseCommandName('/restart')
  check('parseCommandName(/restart)', parsed?.name === 'restart', JSON.stringify(parsed))
}

if (failures > 0) {
  console.error(`\nverify-reload: ${failures} 项失败`)
  process.exit(1)
}
console.log('\nverify-reload: 全部通过')
