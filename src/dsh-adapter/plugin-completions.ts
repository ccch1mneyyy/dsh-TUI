/**
 * `/plugin info <name>` completion: the bundles this profile added.
 *
 * The names come from the same host service and the same predicate the short
 * list reads (`extraBundles` in `./plugin-manager.ts`), so the popup and
 * `/plugin list` cannot disagree about what "added" means.
 *
 * A row's description is the bundle's own title and version — sanitized, capped
 * by display width, and kept in every shipped language, so the popup shows the
 * same title `/plugin info` would and a `/lang` switch repaints it.
 *
 * The cache reads like `/model`'s (`channel/model-actions.ts`): one load, an
 * answer that arrives after the owner moved on is dropped, and the popup is
 * refreshed by `emit()` when the names land. A service that is missing — a
 * non-DSH kernel, an older host — or that throws before it returns a promise
 * answers the same empty list: the tree then shows its static subcommand nodes
 * and nothing throws.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { CommandCompletionNode, LocalizedDescriptions } from '../commands.js'
import { getLang, LANGS, type Lang } from '../i18n.js'
import { extraBundles, pluginManagerOf, pluginTitleIn } from './plugin-manager.js'
import { cleanScalarText } from './sanitize.js'

/**
 * Display-cell budget for one description. The popup truncates to its own row
 * width at render, so this only bounds what a bundle's metadata may park in the
 * cache — a title is host input and arrives as wide as it likes.
 */
const DESCRIPTION_CELLS = 200

/**
 * What one bundle answers to, version included, in every shipped language. The
 * title is host metadata landing in the popup's row, so it is sanitized and
 * capped as a display string (`cleanScalarText`: a newline in a title would
 * leave the row, ANSI would paint it). Every language is built at warm time
 * because the cache loads once; `CommandSuggestions` resolves `descriptions` at
 * render (`localizedDescription`), so `/lang` repaints the popup without a
 * reload and the popup titles a bundle exactly as `/plugin info` does.
 */
function bundleDescriptions(bundle: BundleInfo): LocalizedDescriptions {
  const version = bundle.version === undefined ? '' : ` · ${bundle.version}`
  const built: Partial<Record<Lang, string>> = {}
  for (const lang of LANGS) {
    built[lang] = cleanScalarText(`${pluginTitleIn(bundle, lang, bundle.name)}${version}`, DESCRIPTION_CELLS)
  }
  return built
}

function bundleNode(bundle: BundleInfo): CommandCompletionNode {
  // The package name is what `/plugin info` matches, so it is the token;
  // the title and version are what a person recognizes in the popup. Both
  // come from the report's own reader, per language, so the two never
  // disagree — and neither renders raw host metadata.
  const descriptions = bundleDescriptions(bundle)
  return {
    name: bundle.name,
    description: descriptions[getLang()] ?? bundle.name,
    descriptions,
    ...(bundle.enabled ? {} : { tag: 'off' }),
  }
}

/** The warm-and-read pair the slash completion tree consumes. */
export function createPluginCompletionCatalog(ctx: Context, deps: {
  owner: { readonly signal: AbortSignal; current(): boolean }
  emit(): void
}): {
  warmPluginNames(): void
  pluginNames(): readonly CommandCompletionNode[]
  /** Installed bundles the host will let `/plugin update` act on. */
  updatablePluginNames(): readonly CommandCompletionNode[]
} {
  let nodes: readonly CommandCompletionNode[] | undefined
  let updatable: readonly CommandCompletionNode[] | undefined
  let load: Promise<void> | undefined

  const warmPluginNames = (): void => {
    if (load !== undefined) return
    const manager = pluginManagerOf(ctx)
    if (manager === undefined) {
      nodes = []
      updatable = []
      return
    }
    let pending: Promise<BundleInfo[]>
    try {
      pending = manager.listBundles()
    } catch {
      // The service threw before it returned a promise; `.catch` only covers a
      // rejection, so the raw throw would otherwise reach the keystroke path
      // that asked for the names. Answer an empty list like an absent service,
      // and leave `load` unset so a later warm can try again.
      nodes = []
      updatable = []
      return
    }
    const live = (): boolean => deps.owner.current() && !deps.owner.signal.aborted
    load = pending.then(bundles => {
      // A late answer after a release would write into a dead channel; let a
      // later warm try again instead of pinning the empty result.
      if (!live()) {
        load = undefined
        return
      }
      const extra = extraBundles(bundles)
      nodes = extra.map(bundleNode)
      updatable = extra.filter(bundle => bundle.updatable).map(bundleNode)
      deps.emit()
    }).catch(() => {
      load = undefined
      if (live()) {
        nodes = []
        updatable = []
      }
    })
  }

  return {
    warmPluginNames,
    pluginNames: () => nodes ?? [],
    updatablePluginNames: () => updatable ?? [],
  }
}
