/**
 * Product-facing migration regression for activity presets and tab status.
 *
 * Run with:
 *   node --import tsx/esm scripts/verify-product-migration.ts
 */

import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseActivityFrames,
  readActivityFrames,
  writeActivityFrames,
} from '../src/activityPrefs.js'
import {
  DEFAULT_PRESET,
  FRAME_PRESETS,
  PRESET_NAMES,
  resolvePreset,
} from '../src/components/activityFrames.js'
import { supportsTabStatus } from '../src/ink/termio/osc.js'
import { getTheme, normalizeThemePalette } from '../src/theme.js'
import { parseCustomTheme } from '../src/customTheme.js'

let failures = 0
let checks = 0

function check(name: string, ok: boolean): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

check('legacy activity preference reads as the canonical default',
  parseActivityFrames('{"frames":"claude"}') === DEFAULT_PRESET
  && DEFAULT_PRESET === 'moon8')

check('activity picker names exclude the legacy brand preset',
  !PRESET_NAMES.includes('claude')
  && !Object.hasOwn(FRAME_PRESETS, 'claude'))

const originalRandom = Math.random
try {
  Math.random = () => 0
  const randomPreset = resolvePreset('random')
  const firstName = Object.keys(FRAME_PRESETS)[0]
  check('random activity selection uses current presets only',
    firstName !== undefined
    && firstName !== 'claude'
    && randomPreset === FRAME_PRESETS[firstName])
} finally {
  Math.random = originalRandom
}

const preferenceDir = mkdtempSync(join(tmpdir(), 'dshtui-product-migration-'))
let legacyWriteOk = false
try {
  legacyWriteOk = writeActivityFrames('claude', preferenceDir)
  const raw = JSON.parse(readFileSync(join(preferenceDir, 'working-activity.json'), 'utf8')) as { frames?: unknown }
  legacyWriteOk = legacyWriteOk && raw.frames === DEFAULT_PRESET && readActivityFrames(preferenceDir) === DEFAULT_PRESET
} catch {
  legacyWriteOk = false
} finally {
  rmSync(join(preferenceDir, 'working-activity.json'), { force: true })
  rmdirSync(preferenceDir)
}
check('writing a legacy activity name persists its canonical name', legacyWriteOk)

const savedTabStatus = process.env.DSH_TUI_TAB_STATUS
const savedUserType = process.env.USER_TYPE
try {
  delete process.env.DSH_TUI_TAB_STATUS
  for (const userType of [undefined, 'external', 'internal', 'ant']) {
    if (userType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = userType
    check(`tab status stays opt-in without DSH_TUI_TAB_STATUS (USER_TYPE=${userType ?? 'unset'})`,
      supportsTabStatus() === false)
  }
  process.env.DSH_TUI_TAB_STATUS = '1'
  for (const userType of [undefined, 'external', 'internal', 'ant']) {
    if (userType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = userType
    check(`tab status enables only from DSH_TUI_TAB_STATUS (USER_TYPE=${userType ?? 'unset'})`,
      supportsTabStatus() === true)
  }
} finally {
  if (savedTabStatus === undefined) delete process.env.DSH_TUI_TAB_STATUS
  else process.env.DSH_TUI_TAB_STATUS = savedTabStatus
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
}

const retiredKey = 'briefLabelClaude'
const canonical = getTheme('dark')
check('resolved palettes have no obsolete slots', !Object.keys(canonical).some(key =>
  key === retiredKey || key.endsWith('_FOR_SUBAGENTS_ONLY') || key.startsWith('rainbow_')))
const migrated = normalizeThemePalette({ ...canonical, [retiredKey]: '#123456', briefLabelYou: '#ABCDEF' })
check('legacy resolver slots are removed without replacing canonical prompt color',
  migrated !== undefined && !Object.hasOwn(migrated, retiredKey) && migrated.userPromptLabel === canonical.userPromptLabel)
const legacyFile = parseCustomTheme(JSON.stringify({ base: 'dark', colors: {
  accent: '#123456', [retiredKey]: '#ABCDEF', red_FOR_SUBAGENTS_ONLY: '#987654', rainbow_blue: '#123ABC',
} }), 'migration-probe')
check('unused saved theme slots do not invalidate valid overrides',
  legacyFile?.colors.accent === '#123456' && !Object.hasOwn(legacyFile.colors, retiredKey))

if (failures === 0) {
  console.log(`verify-product-migration: PASS (${checks} checks)`)
  process.exit(0)
}
console.error(`verify-product-migration: FAIL (${failures}/${checks} checks failed)`)
process.exit(1)
