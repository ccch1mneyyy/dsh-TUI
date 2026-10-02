/**
 * 「极简界面」/「极简模式」命名分离门禁（verify:build 的一环）。
 *
 * 两件完全不同的事共用一个中文名是产品事故：
 *   - TUI 显示设置 `dsh-tui.minimal`（**极简界面** / Minimal UI）只精简界面
 *     装饰（开屏头部、emoji 状态符、装饰配色、底栏字段），不影响模型能力；
 *   - 内核 agent preset `minimal`（**极简模式** / Minimal）是能力决策：它改变
 *     模型可见/可调用的工具面（只暴露一个持久 shell 工具）。
 *
 * 本门禁把「谁该叫哪个名字」钉死，任一方向被改回去都会失败：
 *   1. TUI 设置的文案必须自证「极简界面 / Minimal UI」且只谈界面，
 *      并且**绝不**出现裸「极简模式」或旧的 Minimal mode；
 *   2. 内核 preset 的文案必须仍然叫「极简模式 / Minimal」，且显式说明它是
 *      内核 Agent 预设，与界面开关可区分；
 *   3. 持久化配置键仍然是 `minimal`（Config / settings.yaml / cordis.yml 依赖它）；
 *   4. 源码里不再有 `minimalMode` 一代的标识符，且发布面（TuiSceneProps.channel
 *      收到的 ChannelUi）上的 `minimal` / `setMinimal()` 仍作为 deprecated 别名存在；
 *   5. 界面侧的用户可见文案（`/tips` 池、i18n 字典的非 preset 键）不得把内核
 *      预设的名字借回来：裸用「极简模式」即失败，提到该开关处必须叫「极简界面」。
 *
 * 运行：node --import tsx/esm scripts/verify-minimal-ui-naming.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { i18nDict } from '../src/i18n.js'
import { SETTING_DEFINITIONS } from '../src/settings/definitions.js'
import { TIPS } from '../src/tips.js'

const TUI_NAME_ZH = '极简界面'
const KERNEL_NAME_ZH = '极简模式'
// 拼接出旧标识符，本文件自身的字面量因此不会在下面的全量扫描里自命中。
const RETIRED_IDENTIFIERS = [`isMinimal${'Mode'}`, `setMinimal${'Mode'}`, `minimal${'Mode'}.js`]

let failures = 0
function fail(message: string): void {
  failures += 1
  console.error(`  ✗ ${message}`)
}

// ── 1：TUI 显示设置 `dsh-tui.minimal` 只能说「极简界面 / Minimal UI」 ────
const setting = SETTING_DEFINITIONS.minimal
const tuiText = [
  setting.label,
  setting.descriptions?.zh ?? '',
  setting.hint ?? '',
  setting.hintDescriptions?.zh ?? '',
].join('\n')

if (setting.label !== 'Minimal UI') fail(`设置 minimal 的 label 应为 Minimal UI，实际：${setting.label}`)
if (setting.descriptions?.zh !== TUI_NAME_ZH) fail(`设置 minimal 的中文名应为「${TUI_NAME_ZH}」，实际：${setting.descriptions?.zh}`)
if (tuiText.includes(KERNEL_NAME_ZH)) fail(`设置 minimal 的文案出现裸「${KERNEL_NAME_ZH}」——TUI 开关不得借用内核预设的名字`)
if (/Minimal mode/.test(tuiText)) fail('设置 minimal 的文案仍有旧名 Minimal mode')
// 只谈界面：必须写明它只管界面/不管模型能力，并把读者指回 /preset。
if (!/(interface only|not the agent preset)/i.test(setting.hint ?? '')) fail('设置 minimal 的英文 hint 未说明它只管界面、不是 Agent 预设')
if (!/(只是界面开关|不是 Agent 预设|界面开关|只精简界面)/.test(setting.hintDescriptions?.zh ?? '')) fail('设置 minimal 的中文 hint 未说明它只是界面开关')
if (!/\/preset/.test(`${setting.hint ?? ''} ${setting.hintDescriptions?.zh ?? ''}`)) fail('设置 minimal 的 hint 未指回 /preset（内核预设入口）')

// ── 2：内核 preset `minimal` 必须仍叫「极简模式 / Minimal」且可区分 ──────
const kernelName = i18nDict['preset-name-minimal']
const kernelDesc = i18nDict['preset-desc-minimal']
if (kernelName?.zh !== KERNEL_NAME_ZH) fail(`preset-name-minimal 的中文名应保持「${KERNEL_NAME_ZH}」，实际：${kernelName?.zh}`)
if (kernelName?.en !== 'Minimal') fail(`preset-name-minimal 的英文名应保持 Minimal，实际：${kernelName?.en}`)
if (typeof kernelDesc?.zh !== 'string' || !kernelDesc.zh.includes(KERNEL_NAME_ZH)) fail(`preset-desc-minimal 的中文描述必须点明「${KERNEL_NAME_ZH}」`)
if (typeof kernelDesc?.en !== 'string' || !kernelDesc.en.includes('Minimal')) fail('preset-desc-minimal 的英文描述必须点明 Minimal')
if (typeof kernelDesc?.zh !== 'string' || !/内核 Agent 预设/.test(kernelDesc.zh)) fail('preset-desc-minimal 的中文描述未说明它是内核 Agent 预设')
if (typeof kernelDesc?.en !== 'string' || !/Kernel agent preset/.test(kernelDesc.en)) fail('preset-desc-minimal 的英文描述未说明它是内核 Agent 预设')
// 两边的中文名必须是两个不同的字符串，且预设文案不得借用界面开关的名字。
if (kernelName?.zh === setting.descriptions?.zh) fail('TUI 设置与内核 preset 的中文名相同——两个概念又混在一起了')
const kernelText = `${String(kernelDesc?.zh ?? '')} ${String(kernelDesc?.en ?? '')}`
if (kernelText.includes(TUI_NAME_ZH) || /Minimal UI/.test(kernelText)) {
  fail('preset-desc-minimal 出现界面开关的名字（Minimal UI / 极简界面）')
}

// ── 3：持久化配置键仍然叫 `minimal` ────────────────────────────────────
const settingKeys = Object.keys(SETTING_DEFINITIONS)
if (!settingKeys.includes('minimal')) fail('设置定义里找不到持久化键 minimal——配置键不得改名')
if (settingKeys.includes('minimalUi')) fail('设置定义出现了 minimalUi 键——持久化键只能叫 minimal')
const configSource = readFileSync(new URL('../src/dsh-adapter/index.ts', import.meta.url), 'utf8')
if (!/\bminimal\s*:\s*Schema\.boolean\(\)/.test(configSource)) fail('src/dsh-adapter/index.ts 的 Config 里没有 `minimal: Schema.boolean()`——持久化键被改动了')

// ── 4：源码词汇已解耦，发布面的旧名仍作为 deprecated 别名存在 ────────────
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts'], { encoding: 'utf8' })
  .split('\0')
  .filter(file => /\.(ts|tsx|mjs|cjs)$/.test(file))
  .filter(file => existsSync(file))
for (const file of tracked) {
  const content = readFileSync(file, 'utf8')
  for (const identifier of RETIRED_IDENTIFIERS) {
    if (content.includes(identifier)) fail(`${file}: 仍在使用旧标识符 ${identifier}（应改为 minimalUi / isMinimalUiMode / setMinimalUiMode）`)
  }
}
const portSource = readFileSync(new URL('../src/adapter/ports/channel-ui.ts', import.meta.url), 'utf8')
if (!/readonly minimalUi: boolean/.test(portSource)) fail('ChannelUi 缺少 readonly minimalUi: boolean')
if (!/setMinimalUi\(enabled: boolean\): void/.test(portSource)) fail('ChannelUi 缺少 setMinimalUi(enabled: boolean): void')
if (!/readonly minimal: boolean/.test(portSource)) fail('ChannelUi 丢了 deprecated 别名 readonly minimal: boolean（第三方场景插件依赖它）')
if (!/setMinimal\(enabled: boolean\): void/.test(portSource)) fail('ChannelUi 丢了 deprecated 别名 setMinimal(enabled: boolean): void')
// 两个别名都必须标明 deprecation 并指向新名字，读者才知道该迁到哪。
if ((portSource.match(/@deprecated/g) ?? []).length < 2) fail('ChannelUi 的 minimal / setMinimal 别名缺少 @deprecated 标注')
if (!/@deprecated[^\n]*minimalUi/i.test(portSource)) fail('ChannelUi 的别名注释没有指向 minimalUi')
if (!/@deprecated[^\n]*setMinimalUi/.test(portSource)) fail('ChannelUi 的别名注释没有指向 setMinimalUi')
// 只说"deprecated"不够：没有可判定的移除条件（版本 + 何时算安全）别名就会
// 一直留着，场景插件也就永远没有收敛的那一天。两个别名的注释都必须写明。
// 按行回溯到最近的 `/**`：别名注释的正文里可能自带 `/**`（路径 glob），
// 用 lastIndexOf 定位会被它带偏。
function precedingDocComment(source: string, declaration: RegExp): string {
  const lines = source.split('\n')
  const at = lines.findIndex(line => declaration.test(line))
  if (at < 0) return ''
  let start = at
  while (start > 0 && !lines[start]!.trimStart().startsWith('/**')) start -= 1
  return lines.slice(start, at + 1).join('\n')
}
for (const declaration of [/readonly minimal: boolean/, /setMinimal\(enabled: boolean\): void/]) {
  const comment = precedingDocComment(portSource, declaration)
  if (!/REMOVAL/.test(comment)) fail('ChannelUi 的 deprecated 别名注释缺少 REMOVAL 移除条件（"以后再看"不可判定）')
  if (!/v\d+\.\d+/.test(comment)) fail('ChannelUi 的 deprecated 别名注释没有写明移除条件的目标版本（如 v0.12）')
}
// 只看类型的别名断言管不住实现：shadow 模式下的写守卫由 ui-policy 的效果分级决定。
// 旧名一旦被降级成 'read-only'，场景插件就能在 passive/replay shadow 下真的改状态
// （verify-channel-ui 那一档是 `if (effect !== 'mutate') continue`，会静默跳过）。
const policySource = readFileSync(new URL('../src/adapter/channel/ui-policy.ts', import.meta.url), 'utf8')
for (const name of ['setMinimalUi', 'setMinimal']) {
  if (!new RegExp(`'${name}':\\s*'mutate'`).test(policySource)) {
    fail(`ui-policy 里 ${name} 的效果类必须是 'mutate'（降级成 read-only 会绕过 shadow 写守卫）`)
  }
}

// ── 5：界面侧的用户可见文案不得把内核预设的名字借回来 ────────────────────
// 第 1 节只钉住了 /settings 里的设置项文案，挡不住另一条用户可见通道：
// `/tips` 面板（src/tips.ts）。红队实证——把那条同时点出两个概念的提示改回
// 裸「极简模式」后，verify:tips 红在无关的既有失败（tips: en too long
// (flow-question-arrows)）且根本不在 CI 执行面上，没有任何门禁拦得住这次重
// 碰撞。所以这一节直接扫界面侧的文案集合。
//
// 白名单规则（内核 preset 语义的「极简模式」必须继续合法）：
//   - `src/i18n.ts` 里 key 含 `preset` 的条目是白名单：preset-name-minimal /
//     preset-desc-minimal 描述的就是内核 agent preset，「极简模式」是它的
//     正确名字，preset-desc-liangshen 甚至裸用了这个名字；
//   - `presets/**`（随包分发的内核 preset 组合）、`/preset` 选择器与本门禁
//     自身不在扫描面内：本节只覆盖「界面侧用户可见文案」——tips 池与 i18n
//     字典的非 preset 键（设置项自身的 label/description/hint 由第 1 节
//     覆盖，且更严：一处「极简模式」都不许出现）。
// 判据不是"禁止出现「极简模式」"，而是"它出现在界面侧时必须先自证这是内核
// preset"：同一字符串里每处「极简模式」之前都要有 `内核` / `preset` 限定，
// 裸用就是在给界面开关起名；旧英文名 `Minimal mode` 同理，界面侧一处都不许留。
const KERNEL_QUALIFIER = /内核|[Pp]reset/

/** 界面文案里是否裸用了内核预设的中文名（该处之前没有内核/preset 限定）。 */
function hasBareKernelName(text: string): boolean {
  for (let hit = text.indexOf(KERNEL_NAME_ZH); hit >= 0; hit = text.indexOf(KERNEL_NAME_ZH, hit + KERNEL_NAME_ZH.length)) {
    if (!KERNEL_QUALIFIER.test(text.slice(0, hit))) return true
  }
  return false
}

/** i18n 的值可能是复数形 `{ one, other }`；取出其中所有可读文本。 */
function i18nTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  const plural = value as { one?: unknown; other?: unknown }
  return [plural.one, plural.other].filter((text): text is string => typeof text === 'string')
}

const interfaceCopy: Array<{ source: string; key: string; lang: 'zh' | 'en'; text: string }> = []
for (const tip of TIPS) {
  interfaceCopy.push({ source: 'src/tips.ts', key: tip.id, lang: 'zh', text: tip.zh })
  interfaceCopy.push({ source: 'src/tips.ts', key: tip.id, lang: 'en', text: tip.en })
}
for (const [i18nKey, entry] of Object.entries(i18nDict)) {
  if (/preset/i.test(i18nKey)) continue
  for (const lang of ['zh', 'en'] as const) {
    for (const text of i18nTexts(entry[lang])) interfaceCopy.push({ source: 'src/i18n.ts', key: i18nKey, lang, text })
  }
}
for (const { source, key, lang, text } of interfaceCopy) {
  if (hasBareKernelName(text)) {
    fail(`${source}:${key}.${lang} 裸用了「${KERNEL_NAME_ZH}」——界面侧文案不得借用内核预设的名字（白名单只放行 i18n 里 key 含 preset 的条目）`)
  }
  if (/Minimal mode/.test(text)) fail(`${source}:${key}.${lang} 仍有界面开关的旧名 Minimal mode`)
}

// 提到该开关的 /tips 条目必须用新名自证（红队点名的 disp-* / pit-* 一类）。
// id 里含 `preset` 的条目按白名单豁免：那是只讲内核预设的提示，不负责点名
// 界面开关（与 i18n 的 key 含 preset 白名单同一条规则）。
const switchTips = TIPS.filter(tip => /minimal/i.test(tip.id) && !/preset/i.test(tip.id))
if (switchTips.length === 0) fail('src/tips.ts 里没有 id 含 minimal 的条目——界面开关在 /tips 面板上失去自证（条目被改名？）')
for (const tip of switchTips) {
  if (!tip.zh.includes(TUI_NAME_ZH)) fail(`src/tips.ts:${tip.id}.zh 没有出现「${TUI_NAME_ZH}」——提到该开关的条目不得用内核预设的名字「${KERNEL_NAME_ZH}」`)
  if (!tip.en.includes('Minimal UI')) fail(`src/tips.ts:${tip.id}.en 没有出现 Minimal UI——提到该开关的条目不得用旧名 Minimal mode`)
}

if (failures > 0) {
  console.error(`verify-minimal-ui-naming: ${failures} 处失败`)
  process.exit(1)
}
console.log(`✓ verify-minimal-ui-naming: TUI 设置=${setting.label}/${setting.descriptions?.zh}，内核 preset=${kernelName.en}/${kernelName.zh}，持久化键 minimal 未变，界面侧文案无重碰撞`)
