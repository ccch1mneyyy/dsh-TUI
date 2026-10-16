import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { packagedPresetRoot } from './packaged-presets.js'
import { PRESET_PATCH_MODULE } from '../preset-patch.js'

/** Upstream presets copied into the roster by id; liangshen ships in this package. */
const UPSTREAM_PRESET_IDS: readonly string[] = ['standard', 'ptc', 'minimal', 'cordis']

interface DeclarativePresets {
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

interface PresetLoader {
  entries(): Iterable<{ disabled: boolean; options: { name?: string; config?: unknown } }>
}

function declarativePresets(ctx: Context): DeclarativePresets | undefined {
  const service: unknown = ctx.get('agentPresets')
  return service !== null && typeof service === 'object'
    && 'register' in service && typeof service.register === 'function'
    ? service as DeclarativePresets
    : undefined
}

/** Preserve the Loader's expressions; only the owning plugin may evaluate them. */
function readPresetPatch(path: string): PresetDefinition {
  const patches: unknown = parse(readFileSync(path, 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  })
  if (Array.isArray(patches) && patches.length === 1) {
    const row = patches[0]?.insert?.[0]
    if (row?.name === '@deepseek-ai/dsh-agent-preset'
      && typeof row.config?.id === 'string' && Array.isArray(row.config.plugins)) {
      return row.config as PresetDefinition
    }
  }
  throw new Error(`dsh-tui: invalid upstream preset declaration: ${path}`)
}

type RowConfigs = ReadonlyMap<string, unknown>

/** Preset id → row id → replacement config, from preset-patch rows (src/preset-patch.ts). */
function presetPatches(ctx: Context, loader: PresetLoader | undefined): Map<string, Map<string, unknown>> {
  const patches = new Map<string, Map<string, unknown>>()
  for (const entry of loader?.entries() ?? []) {
    if (entry.disabled || entry.options.name !== PRESET_PATCH_MODULE) continue
    const config = entry.options.config as { preset?: unknown; config?: unknown } | undefined
    const rows = config?.config
    if (typeof config?.preset !== 'string' || rows === null || typeof rows !== 'object' || Array.isArray(rows)) {
      ctx.logger.warn('dsh-tui: ignoring a preset-patch row without `preset` and a `config` map')
      continue
    }
    const target = patches.get(config.preset) ?? new Map<string, unknown>()
    for (const [id, value] of Object.entries(rows)) target.set(id, value)
    patches.set(config.preset, target)
  }
  return patches
}

/** Copy an entry list with the named rows' `config` replaced, nested groups included. */
function withRowConfigs<T>(rows: readonly T[], configs: RowConfigs, matched: Set<string>): T[] {
  return rows.map((row) => {
    const entry = row as { id?: unknown; group?: unknown; config?: unknown }
    if (typeof entry.id === 'string' && configs.has(entry.id)) {
      matched.add(entry.id)
      return { ...row, config: configs.get(entry.id) }
    }
    if (entry.group === true && Array.isArray(entry.config)) return { ...row, config: withRowConfigs(entry.config, configs, matched) }
    return row
  })
}

function patchDefinition(ctx: Context, definition: PresetDefinition, configs: RowConfigs | undefined): PresetDefinition {
  if (configs === undefined) return definition
  const matched = new Set<string>()
  const plugins = withRowConfigs(definition.plugins, configs, matched)
  for (const id of configs.keys()) {
    if (!matched.has(id)) ctx.logger.warn(`dsh-tui: preset-patch row "${id}" not found in preset "${definition.id}"`)
  }
  return { ...definition, plugins }
}

/**
 * 0.1.7 removed directory discovery. Consume the official bundle definitions
 * through its registry, without copying or reimplementing their tool sets.
 * Web/profile declarations own their seats even while still activating.
 * Returns false on the legacy directory-backed roster or while absent. An
 * absent service is watched through Cordis so a late registry is not missed.
 */
export async function registerBundledPresets(ctx: Context): Promise<boolean> {
  if (ctx.get('agentPresets') === undefined) {
    ctx.inject(['agentPresets'], async (ready) => {
      await registerBundledPresets(ready)
    })
    return false
  }
  if (declarativePresets(ctx) === undefined) return false
  const declared = new Set<string>()
  const loader = ctx.get('loader') as PresetLoader | undefined
  for (const entry of loader?.entries() ?? []) {
    if (entry.disabled || entry.options.name !== '@deepseek-ai/dsh-agent-preset') continue
    const config: unknown = entry.options.config
    if (config !== null && typeof config === 'object' && 'id' in config && typeof config.id === 'string') {
      declared.add(config.id)
    }
  }
  const patches = presetPatches(ctx, loader)
  const require = createRequire(ctx.baseUrl ?? import.meta.url)
  for (const id of UPSTREAM_PRESET_IDS) {
    if (declared.has(id)) continue
    const path = require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)
    const owner = ctx.extend({ baseUrl: pathToFileURL(path).href })
    const dispose = await declarativePresets(owner)!.register(patchDefinition(ctx, readPresetPatch(path), patches.get(id)))
    ctx.effect(() => dispose)
  }
  if (!declared.has('liangshen')) {
    const root = join(packagedPresetRoot(), 'liangshen')
    const metadata: Pick<PresetDefinition, 'name' | 'description' | 'order'> = parse(readFileSync(join(root, 'preset.yml'), 'utf8'))
    const dispose = await declarativePresets(ctx)!.register({
      id: 'liangshen',
      name: metadata.name,
      description: metadata.description,
      order: metadata.order,
      plugins: [{
        id: 'liangshen-plugins',
        name: '@deepseek-ai/cordis-plugin-include',
        config: {
          path: pathToFileURL(join(root, 'agent.cordis.yml')).href,
          patches: [...patches.get('liangshen') ?? []].map(([id, config]) => ({ id, config })),
        },
      }],
    })
    ctx.effect(() => dispose)
  }
  // A typo in `preset` would otherwise be a silent no-op (row ids warn inside
  // patchDefinition). Profile-declared presets are the profile's own seats.
  for (const preset of patches.keys()) {
    if (preset === 'liangshen' || UPSTREAM_PRESET_IDS.includes(preset) || declared.has(preset)) continue
    ctx.logger.warn(`dsh-tui: preset-patch row names a preset dsh-tui does not register: "${preset}"`)
  }
  return true
}
