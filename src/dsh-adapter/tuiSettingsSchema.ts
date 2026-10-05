/**
 * The `dsh-tui` settings schema: what `settings.register()` resolves a
 * legacy settings document through (hosts that own a settings document —
 * DSH 0.1.5 and older, or a newer host whose settings service is patched
 * back to `register()`), and the shape the plugin reads either way.
 *
 * Shared by the plugin (plugin.ts, `createSettingsScope`) and the `dst`
 * preload (src/preboot/mount.ts), so the boot screen resolves a legacy
 * document exactly as the live session will: a field with a schema default
 * is decided by the document alone, one without falls through to Config.
 */
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_STATUS_BAR, normalizePageMargin } from '../tuiDisplayPrefs.js'
import { SHORTCUT_ACTIONS } from '../utils/keymap.js'

export function createTuiSettingsSchema() {
  return Schema.object({
    diffLayout: Schema.union(['auto', 'split', 'unified']).default('auto'),
    thinkingFold: Schema.union(['preview', 'full']).default('preview'),
    jobGroupFold: Schema.union(['auto', 'always', 'never']).default('auto'),
    toolBackground: Schema.union(['none', 'subtle', 'strong']).default('none'),
    scrollGutter: Schema.union(['timeline', 'scrollbar', 'hidden']).default('timeline'),
    // Preset names AND custom `NxM` specs (the settings field's parse
    // gate keeps junk out of the user layer; the transform normalizes
    // whatever survives — cordis.yml junk included).
    pageMargin: Schema.transform(
      Schema.string().default('normal'),
      value => normalizePageMargin(value),
    ),
    // No default on purpose (same rule as `fullscreen` below): a schema
    // default here would come back from scope.get()/watch() and shadow
    // an explicit cordis.yml `foldTerminalCommand: true` while the
    // settings user layer is unset — applyDisplay's
    // `?? config.foldTerminalCommand ?? false` already supplies the
    // default and keeps cordis.yml decisive.
    foldTerminalCommand: Schema.boolean(),
    // Same no-default rule as foldTerminalCommand: applyDisplay resolves
    // `?? config.turnUsageRow ?? false` so cordis.yml stays decisive.
    turnUsageRow: Schema.boolean(),
    promptSessionLabel: Schema.boolean().default(false),
    // No schema default (same rule as foldTerminalCommand): applyDisplay
    // resolves `?? config.expandEditor ?? true` so cordis.yml stays
    // decisive while the user layer is unset.
    expandEditor: Schema.boolean(),
    // Same no-default rule: applyDisplay resolves `?? config.smoothStreaming ?? true`.
    smoothStreaming: Schema.boolean(),
    // Same no-default rule: applyDisplay resolves `?? config.mermaidDiagrams ?? true`.
    mermaidDiagrams: Schema.boolean(),
    // Code-frame shape; unset keeps the light rail frame.
    codeFrameStyle: Schema.union(['light', 'full']),
    // Same no-default rule: resolveMathRendering falls back to cordis.yml.
    mathRendering: Schema.union(['auto', 'image', 'unicode', 'source']),
    // Display-formula image size; unset keeps the base (text) scale.
    mathImageScale: Schema.union(['auto', 'large', 'xlarge']),
    // Formula-image backing; unset keeps the transparent default.
    mathImageBacking: Schema.union(['transparent', 'terminal']),
    // Transcript-image backing (photos); unset keeps the transparent default.
    imageBacking: Schema.union(['transparent', 'terminal']),
    // Pre-`mathRendering` user layers; `false` still resolves to `source`.
    latexMath: Schema.boolean(),
    // No default on purpose: unset keeps the boot chain decisive
    // (applyEffortDefault hands `undefined` to channel.setDefaultEffort,
    // which resolves cordis.yml `effort` → effort.json → adapter default).
    effortDefault: Schema.string(),
    statusBar: Schema.object({
      compact: Schema.boolean().default(DEFAULT_STATUS_BAR.compact),
      model: Schema.boolean().default(DEFAULT_STATUS_BAR.model),
      thinking: Schema.boolean().default(DEFAULT_STATUS_BAR.thinking),
      cwd: Schema.boolean().default(DEFAULT_STATUS_BAR.cwd),
      contextUsage: Schema.boolean().default(DEFAULT_STATUS_BAR.contextUsage),
      cache: Schema.boolean().default(DEFAULT_STATUS_BAR.cache),
      tokens: Schema.boolean().default(DEFAULT_STATUS_BAR.tokens),
      cost: Schema.boolean().default(DEFAULT_STATUS_BAR.cost),
      tps: Schema.boolean().default(DEFAULT_STATUS_BAR.tps),
      gitBranch: Schema.boolean().default(DEFAULT_STATUS_BAR.gitBranch),
      sessionTitle: Schema.boolean().default(DEFAULT_STATUS_BAR.sessionTitle),
      sessionId: Schema.boolean().default(DEFAULT_STATUS_BAR.sessionId),
      goal: Schema.boolean().default(DEFAULT_STATUS_BAR.goal),
      mode: Schema.boolean().default(DEFAULT_STATUS_BAR.mode),
      contextBar: Schema.boolean().default(DEFAULT_STATUS_BAR.contextBar),
      activity: Schema.boolean().default(DEFAULT_STATUS_BAR.activity),
      trajectory: Schema.boolean().default(DEFAULT_STATUS_BAR.trajectory),
      shortcutHint: Schema.boolean().default(DEFAULT_STATUS_BAR.shortcutHint),
    }).default({ ...DEFAULT_STATUS_BAR }),
    // Side-panel preferences. No schema defaults on purpose (same rule as
    // foldTerminalCommand/expandEditor above): a default here would come
    // back from scope.get()/watch() and shadow an explicit cordis.yml
    // `sidePanel` block while the user layer is unset. applyDisplay
    // resolves `?? config.sidePanel?.x` and the apply* stores normalize
    // undefined to the documented defaults (true / false / 0.68 / the
    // built-in panel trio).
    sidePanel: Schema.object({
      splitEnabled: Schema.boolean(),
      open: Schema.boolean(),
      ratio: Schema.number(),
      panels: Schema.string(),
    }),
    companion: Schema.object({
      skin: Schema.string(),
    }),
    // btw thread-context budgets (settings `btw.*`): no schema defaults
    // (same rule as sidePanel above) — the apply* stores normalize an
    // unset value to 4 turns / 24k chars.
    btw: Schema.object({
      contextTurns: Schema.number(),
      contextBudget: Schema.number(),
    }),
    // Header pixel whale art; on unless settings.yaml says otherwise.
    whale: Schema.boolean().default(true),
    // Idle whale behaviors after the intro settles; on by default —
    // the idle-wakeup gate stays: an explicit `false` keeps the settled
    // header timer-free.
    whaleIdle: Schema.boolean().default(true),
    // Maid portrait instead of the pixel whale in the header splash;
    // off by default — the portrait is static (no idle animation).
    whaleGirl: Schema.boolean().default(false),
    // No schema default (same rule as foldTerminalCommand below): a
    // default here would come back from scope.get()/watch() and shadow an
    // explicit cordis.yml `splashFont` while the user layer is unset.
    // applySplashFont resolves `?? config.splashFont` and normalizes it
    // (undefined → daily), so cordis.yml stays decisive and junk lands on
    // daily.
    splashFont: Schema.string(),
    // 品牌外观：与 splashFont 同规则——用户层不设默认，cordis.yml 保持
    // 决定权；applyBrand 归一化（undefined → auto）。
    brand: Schema.string(),
    // Minimal UI (极简界面, settings key `minimal` — never renamed): strips
    // the header splash, emoji glyphs, and decorative colors; code highlight
    // and tool colors stay. Unrelated to the kernel agent preset `minimal`.
    minimal: Schema.boolean().default(false),
    // No default on purpose: an unset `lang` keeps the field showing
    // the effective language (see the section's format below) and lets
    // cordis.yml / lang.json keep their precedence.
    lang: Schema.union(['zh', 'en']),
    // Same no-default rule: unset keeps cordis.yml's `fullscreen`
    // decisive; set overrides it from the next boot on.
    fullscreen: Schema.boolean(),
    // Unset inherits cordis.yml; a saved choice takes effect after restart.
    terminalImages: Schema.boolean(),
    // Built-in action-shortcut overrides, one optional combo string per
    // action (see the keymap utility). Unset keeps the default binding
    // and the section's format() shows the effective combos.
    shortcuts: Schema.object(
      Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, Schema.string().required(false)])),
    ).required(false),
  })
}

/**
 * A legacy settings document's `dsh-tui` section as `register()` hands it to
 * the plugin: schema-resolved, so defaulted fields are always set and the
 * rest stay undefined. A section the schema rejects would make the live
 * `register()` throw too; the raw section is the closest boot-time guess.
 */
export function resolveTuiSettingsDocument(section: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    return createTuiSettingsSchema()(section) as Readonly<Record<string, unknown>>
  } catch {
    return section
  }
}
