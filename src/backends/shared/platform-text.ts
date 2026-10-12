/**
 * The platform copy the host UI and the built-in backends both render, as one
 * source (C-2): the status line's rate-limit window, /doctor, /rename, rewind
 * and the names of the tool cards a backend shares with the host's own cards.
 *
 * Why a shared *source* rather than a shared dictionary: the host dictionary
 * (`src/i18n.ts`) is not readable from a backend (D2), so each of these strings
 * used to be copied byte for byte into a backend's own text module as well —
 * two copies of one string, with nothing keeping them equal. The values now
 * come from here; each side still carries the entry in its own dictionary and
 * renders it the way it always did. `scripts/verify-i18n.ts` compares the host
 * dictionary and both backend dictionaries against this file verbatim, so a
 * copy that drifts — or an inline one written back over the spread — turns
 * that gate red.
 *
 * D2 is unchanged: a third-party contribution must not be able to speak with
 * the host's words. The layers a contribution occupies
 * (`src/{screens,components,hooks,ink}/**`, `src/channel/**`) are kept out of
 * `src/backends/**` by `scripts/verify-adapter-boundary.ts`, so this file is
 * read only by the host dictionary and the two in-tree backends — never by a
 * plugin. The seam itself may not read the host dictionary either (same gate),
 * which is what keeps this route one-way.
 */
import type { LocalizedText } from './localized-text.js'

/** One platform string in the languages the TUI ships. */
export interface PlatformTextEntry {
  readonly zh: LocalizedText
  readonly en: LocalizedText
}

/**
 * The shared platform copy. The keys are the union of what the claude and
 * codex text modules render on a platform surface; the host dictionary spreads
 * this object in, so its `keyof` stays a literal union and `t()` keeps its
 * type safety — do not widen this declaration with a `Record<string, …>`
 * annotation, which would collapse that union to `string`.
 */
export const PLATFORM_TEXT = Object.freeze({
  'capability-failed': Object.freeze({ zh: '{{name}} 失败 · {{err}}', en: '{{name}} failed · {{err}}' }),
  'status-rate-limit-five-hour': Object.freeze({ zh: '5小时', en: '5h' }),
  'status-rate-limit-seven-day': Object.freeze({ zh: '7天', en: '7d' }),
  'doctor-unknown': Object.freeze({ zh: '未知', en: 'unknown' }),
  'effort-invalid': Object.freeze({ zh: '未知推理等级 {{id}}（当前模型可选：{{ids}}）', en: 'Unknown reasoning effort {{id}} (this model offers: {{ids}})' }),
  'tool-name-bash': Object.freeze({ zh: 'Bash', en: 'Bash' }),
  'tool-name-edit': Object.freeze({ zh: '编辑', en: 'Edit' }),
  'rewind-first-message': Object.freeze({ zh: '不能回退到第一条消息之前', en: 'Cannot rewind past the very first message' }),
  'rename-failed': Object.freeze({ zh: '重命名失败 · {{err}}', en: 'Rename failed · {{err}}' }),
  'rename-usage': Object.freeze({ zh: '用法  /rename <新名称>', en: 'Usage  /rename <new title>' }),
} satisfies Record<string, PlatformTextEntry>)

/** A key of {@link PLATFORM_TEXT}; a typo is a compile error. */
export type PlatformTextKey = keyof typeof PLATFORM_TEXT

/** The value type of one {@link PLATFORM_TEXT} entry. */
type PlatformTextValue = (typeof PLATFORM_TEXT)[PlatformTextKey]

/**
 * The frozen subset of {@link PLATFORM_TEXT} holding exactly `keys` — the
 * platform strings this backend renders, and nothing else. `K` is constrained
 * to {@link PlatformTextKey}, so a mistyped key is a compile error rather than
 * a string that silently disappears from the screen.
 */
export function pickPlatformText<K extends PlatformTextKey>(keys: readonly K[]): Readonly<Pick<typeof PLATFORM_TEXT, K>> {
  const picked: Partial<Record<PlatformTextKey, PlatformTextValue>> = {}
  for (const key of keys) picked[key] = PLATFORM_TEXT[key]
  // The loop fills exactly `keys`; a mapped type cannot express that, so the
  // assertion is the one step TypeScript cannot check here.
  return Object.freeze(picked) as Readonly<Pick<typeof PLATFORM_TEXT, K>>
}
