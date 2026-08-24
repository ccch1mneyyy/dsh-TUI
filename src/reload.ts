/**
 * `/reload` planning — the pi-style soft reload: re-read the TUI's persisted
 * preference files (`~/.dsh-tui/{theme,lang,agent-preset,model,
 * working-activity}.json`) and decide what to re-apply live, honoring the
 * same boot-time precedence every picker does:
 *
 *   - theme:    DSH_TUI_THEME wins; else theme.json.
 *   - lang:     DSH_TUI_LANG > settings `dsh-tui.lang` (folded in by the
 *               caller as `langOverriddenBySettings`) > cordis.yml `lang`
 *               > lang.json.
 *   - preset:   cordis.yml `preset` wins; else agent-preset.json.
 *   - model:    a COMPLETE cordis.yml provider/model pair wins whole
 *               (issue #67 — never merge halves); else model.json.
 *   - activity: cordis.yml `activityFrames` wins; else
 *               working-activity.json.
 *
 * Settings-namespace values (settings.yaml user layer) are deliberately NOT
 * re-read here: the dsh-tui namespace applies live through its settings
 * watch and hot-reloads its document through the platform's file watcher,
 * so /reload only needs the five boot-only pref files. What no reload can
 * re-read (cordis.yml root config, frozen fullscreen layout, newly built
 * code) is the job of `/restart`.
 *
 * Pure and injectable so scripts/verify-reload.ts can exercise every branch
 * without a UI or a file system.
 */

import type { Lang } from './i18n.js'
import type { ModelPref } from './modelPrefs.js'
import type { ModelRoute } from './modelRoute.js'
import { explicitModelRoute } from './modelRoute.js'

/** The five boot-only preference surfaces /reload re-reads. */
export type ReloadKind = 'theme' | 'lang' | 'preset' | 'model' | 'activity'

export type ReloadSkipReason =
  /** A launch-time environment variable pins the value (DSH_TUI_THEME / DSH_TUI_LANG). */
  | 'env-wins'
  /** cordis.yml or the settings user layer pins the value; the pref must not override it. */
  | 'config-wins'
  /** The pref file is missing or unparsable. */
  | 'invalid'

/** One live change /reload applies. Kind `model` carries the route halves. */
export interface ReloadApply {
  kind: ReloadKind
  /** The live value before this reload. */
  from: string
  /** The value the pref file now names. */
  to: string
  /** Present for kind `model`: the full route halves to switch to. */
  route?: ModelRoute
}

/** A pref /reload did not apply, and why. */
export interface ReloadSkip {
  kind: ReloadKind
  reason: ReloadSkipReason
}

/** What one /reload run decided, before any side effects. */
export interface ReloadPlan {
  /** Apply these in order (theme → lang → preset → model → activity). */
  apply: ReloadApply[]
  /** Pref files whose value already matches the live state. */
  unchanged: ReloadKind[]
  /** Pref files not applied, and why. */
  skipped: ReloadSkip[]
}

/** Everything the planner needs — caller reads the files and live values. */
export interface ReloadInput {
  /** DSH_TUI_THEME, when it holds a valid theme name. */
  envTheme?: string
  /** DSH_TUI_LANG, when it holds a valid language. */
  envLang?: string
  /** Fresh readThemePref(). */
  themePref?: string
  /** The live theme name (ThemeProvider state). */
  currentTheme: string
  /** Fresh readLangPref(). */
  langPref?: Lang
  /** The live UI language. */
  currentLang: Lang
  /** True when the settings user layer (settings.yaml `dsh-tui.lang`) pins a language. */
  langOverriddenBySettings: boolean
  /** cordis.yml's raw `lang` key, when set. */
  configuredLang?: string
  /** cordis.yml's explicit `preset` key, when set. */
  configuredPreset?: string
  /** Fresh readPresetPref(). */
  presetPref?: string
  /** The live preset id (channel.agentPreset; undefined = roster default). */
  currentPreset?: string
  /** cordis.yml's raw `provider`/`model` keys, when set. */
  configuredModel?: { provider?: string; model?: string }
  /** Fresh readModelPref(). */
  modelPref?: ModelPref
  /** The live route (channel provider/model). */
  currentModel?: ModelRoute
  /** cordis.yml's explicit `activityFrames` key, when set. */
  configuredActivity?: string
  /** Fresh readActivityFrames(). */
  activityPref?: string
  /** The live activity preset (channel.activityFrames). */
  currentActivity?: string
}

/**
 * Decide what one /reload applies. Pure: returns the plan, never touches
 * the UI or the channel. The caller executes `apply` in order and renders
 * the report.
 */
export function planReload(input: ReloadInput): ReloadPlan {
  const apply: ReloadApply[] = []
  const unchanged: ReloadKind[] = []
  const skipped: ReloadSkip[] = []

  // Theme: env override wins at launch; else the persisted choice.
  if (input.envTheme !== undefined) {
    skipped.push({ kind: 'theme', reason: 'env-wins' })
  } else if (input.themePref === undefined) {
    skipped.push({ kind: 'theme', reason: 'invalid' })
  } else if (input.themePref === input.currentTheme) {
    unchanged.push('theme')
  } else {
    apply.push({ kind: 'theme', from: input.currentTheme, to: input.themePref })
  }

  // Language: env, then the settings user layer, then cordis.yml, then the
  // persisted choice — mirror the boot precedence in plugin.apply.
  if (input.envLang !== undefined) {
    skipped.push({ kind: 'lang', reason: 'env-wins' })
  } else if (input.langOverriddenBySettings || input.configuredLang !== undefined) {
    skipped.push({ kind: 'lang', reason: 'config-wins' })
  } else if (input.langPref === undefined) {
    skipped.push({ kind: 'lang', reason: 'invalid' })
  } else if (input.langPref === input.currentLang) {
    unchanged.push('lang')
  } else {
    apply.push({ kind: 'lang', from: input.currentLang, to: input.langPref })
  }

  // Preset: cordis.yml's static choice wins; else the persisted one.
  if (input.configuredPreset !== undefined) {
    skipped.push({ kind: 'preset', reason: 'config-wins' })
  } else if (input.presetPref === undefined) {
    skipped.push({ kind: 'preset', reason: 'invalid' })
  } else if (input.presetPref === input.currentPreset) {
    unchanged.push('preset')
  } else {
    apply.push({ kind: 'preset', from: input.currentPreset ?? '—', to: input.presetPref })
  }

  // Model route: the atomic rule (issue #67) — a complete cordis.yml pair
  // wins whole; a half-pinned config never merges with the pref's other half.
  // (Normalize to an object: callers may pass undefined when no route is pinned.)
  if (explicitModelRoute(input.configuredModel ?? {}) !== undefined) {
    skipped.push({ kind: 'model', reason: 'config-wins' })
  } else if (input.modelPref === undefined) {
    skipped.push({ kind: 'model', reason: 'invalid' })
  } else if (
    input.currentModel !== undefined
    && input.currentModel.provider === input.modelPref.provider
    && input.currentModel.model === input.modelPref.model
  ) {
    unchanged.push('model')
  } else {
    apply.push({
      kind: 'model',
      from: input.currentModel === undefined
        ? '—'
        : `${input.currentModel.provider}/${input.currentModel.model}`,
      to: `${input.modelPref.provider}/${input.modelPref.model}`,
      route: { provider: input.modelPref.provider, model: input.modelPref.model },
    })
  }

  // Working-activity indicator: cordis.yml's static choice wins.
  if (input.configuredActivity !== undefined) {
    skipped.push({ kind: 'activity', reason: 'config-wins' })
  } else if (input.activityPref === undefined) {
    skipped.push({ kind: 'activity', reason: 'invalid' })
  } else if (input.activityPref === input.currentActivity) {
    unchanged.push('activity')
  } else {
    apply.push({ kind: 'activity', from: input.currentActivity ?? 'claude', to: input.activityPref })
  }

  return { apply, unchanged, skipped }
}
