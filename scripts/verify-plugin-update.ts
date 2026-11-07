/**
 * `/plugin update [bundle ...]`: target selection, host calls, reporting and
 * failure/restore handling, against a fake plugin manager.
 *
 * The host service owns version listing and the profile write; this battery
 * pins the decisions the TUI makes on top of it:
 *   - no arguments = every updatable bundle, named arguments narrow it;
 *   - `latest` wins over a newer non-tagged release;
 *   - deprecated / incompatible / non-bundle versions are never chosen;
 *   - non-updatable and unknown names are skipped without a write;
 *   - a running turn refuses before any service call;
 *   - update-state progress is reported with the request id the flow supplied;
 *   - a failed update reports the failure and the restored previous version.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-update.ts
 */
import assert from 'node:assert/strict'
import {
  chooseUpdateVersion,
  createPluginUpdateFlow,
  type PluginUpdateFlow,
} from '../src/dsh-adapter/plugin-update.js'
import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import { gatedPluginWrite, userPluginsAllowed } from '../src/pluginPolicy.js'

let checks = 0
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1
  if (!ok) throw new Error(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

interface FakeBundle {
  readonly name: string
  readonly installed: boolean
  readonly updatable: boolean
  readonly enabled: boolean
  readonly version: string
}

const bundle = (name: string, updatable = true, version = '1.0.0'): FakeBundle =>
  ({ name, installed: true, updatable, enabled: true, version })

interface FakeListing {
  readonly installed: string
  readonly registry: string
  readonly versions: readonly {
    readonly version: string
    readonly tags: readonly string[]
    readonly prerelease: boolean
    readonly bundle: boolean
    readonly deprecated?: string
    readonly incompatible?: unknown
  }[]
}

interface FakeManager {
  readonly manager: PluginManagerView
  readonly calls: Array<{ name: string; version: string; registry?: string | null; requestId?: string }>
}

function fakeManager(options: {
  bundles: readonly FakeBundle[]
  listings: Record<string, FakeListing | { readonly refused: string; readonly problem: 'network' | 'not-found' | 'not-updatable' }>
  result?: (name: string, version: string) => unknown
}): FakeManager {
  const calls: FakeManager['calls'] = []
  const manager = {
    async listBundles() { return options.bundles },
    async listVersions(name: string) {
      const listing = options.listings[name]
      if (listing === undefined) throw new Error(`unexpected listing ${name}`)
      if ('refused' in listing) {
        return { status: 'refused', problem: listing.problem, reason: listing.refused, attempts: [] }
      }
      return {
        status: 'listed',
        installed: listing.installed,
        registry: listing.registry,
        versions: listing.versions,
        attempts: [],
        omitted: 0,
      }
    },
    async updateBundle(name: string, version: string, updateOptions: { registry?: string | null; requestId?: string }) {
      calls.push({ name, version, registry: updateOptions.registry, requestId: updateOptions.requestId })
      if (options.result !== undefined) return options.result(name, version)
      return {
        from: '1.0.0',
        to: version,
        step: 'install',
        result: { changed: true, application: 'applied', stage: 'install', target: `${name}@${version}` },
      }
    },
  } as unknown as PluginManagerView
  return { manager, calls }
}

function runUpdate(manager: PluginManagerView, targets: readonly string[], busy = false, events?: {
  onState(listener: (progress: { requestId: string; step: 'checking' | 'removing' | 'installing' | 'restoring' }) => void): () => void
}): { flow: PluginUpdateFlow; lines: string[] } {
  const lines: string[] = []
  const flow = createPluginUpdateFlow({
    manager,
    targets,
    busy: () => busy,
    binding: () => 1,
    onLines: values => lines.push(...values),
    events: events as never,
  })
  return { flow, lines }
}

// ── The read-only Nix profile gates install / update / remove ──────────────
{
  const previous = process.env.DSH_TUI_ALLOW_USER_PLUGINS
  process.env.DSH_TUI_ALLOW_USER_PLUGINS = '0'
  check('read-only policy is off', !userPluginsAllowed())
  check('install is a gated write', gatedPluginWrite('install ./plugin') === 'install')
  check('update is a gated write', gatedPluginWrite('update alpha') === 'update')
  check('remove is a gated write', gatedPluginWrite('remove alpha') === 'remove')
  check('enable is not a gated write', gatedPluginWrite('enable alpha') === undefined)
  check('list is not a gated write', gatedPluginWrite('list') === undefined)
  if (previous === undefined) delete process.env.DSH_TUI_ALLOW_USER_PLUGINS
  else process.env.DSH_TUI_ALLOW_USER_PLUGINS = previous
  check('unset policy keeps npm/source writable', userPluginsAllowed())
}

// ── `latest` is the target, not the newest untagged release ─────────────────
{
  const target = chooseUpdateVersion([
    { version: '2.0.0-beta', tags: [], prerelease: true, bundle: true },
    { version: '1.5.0', tags: [], prerelease: false, bundle: true },
    { version: '1.6.0', tags: ['latest'], prerelease: false, bundle: false },
    { version: '1.7.0', tags: ['latest'], prerelease: false, bundle: true, deprecated: 'broken' },
    { version: '1.8.0', tags: ['latest'], prerelease: false, bundle: true, incompatible: {} },
    { version: '1.9.0', tags: ['latest'], prerelease: false, bundle: true },
  ])
  check('latest tagged bundle wins over a newer untagged release', target?.version === '1.9.0', target?.version)
  check('no stable target when only prereleases remain',
    chooseUpdateVersion([{ version: '2.0.0-beta', tags: [], prerelease: true, bundle: true }]) === undefined)
}

// ── No arguments updates every updatable bundle and reports a summary ───────
{
  const fake = fakeManager({
    bundles: [bundle('alpha'), bundle('beta', true, '2.0.0'), bundle('gamma', false, '3.0.0')],
    listings: {
      alpha: {
        installed: '1.0.0', registry: 'https://registry.example',
        versions: [
          { version: '1.2.0', tags: [], prerelease: false, bundle: true },
          { version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true },
        ],
      },
      beta: { installed: '2.0.0', registry: 'https://registry.example', versions: [] },
    },
  })
  const { flow, lines } = runUpdate(fake.manager, [])
  await flow.run()
  check('all-form writes exactly the updatable bundle', fake.calls.length === 1, JSON.stringify(fake.calls))
  check('all-form targets the latest tag', fake.calls[0]?.version === '1.1.0', fake.calls[0]?.version)
  check('the listing registry is passed to the update', fake.calls[0]?.registry === 'https://registry.example')
  check('a request id is supplied', typeof fake.calls[0]?.requestId === 'string' && fake.calls[0].requestId.length > 0)
  check('summary reports one updated and one current',
    lines.some(line => line.includes('1 updated') && line.includes('1 current')), lines.join('\n'))
}

// ── Names narrow the selection; unknown and non-updatable are skipped ───────
{
  const fake = fakeManager({
    bundles: [bundle('alpha'), bundle('gamma', false)],
    listings: {},
  })
  const { flow, lines } = runUpdate(fake.manager, ['gamma', 'missing'])
  await flow.run()
  check('named non-updatable and unknown names never write', fake.calls.length === 0)
  check('non-updatable is named', lines.some(line => line.includes('gamma') && line.includes('third-party')))
  check('unknown is named', lines.some(line => line.includes('missing') && line.includes('not an installed bundle')))
  check('summary counts both as skipped', lines.some(line => line.includes('2 skipped')), lines.join('\n'))
}

// ── A running turn refuses before touching the service ─────────────────────
{
  const fake = fakeManager({ bundles: [bundle('alpha')], listings: {} })
  const { flow, lines } = runUpdate(fake.manager, [], true)
  await flow.run()
  check('busy refusal does not write', fake.calls.length === 0)
  check('busy refusal says why', lines.some(line => line.includes('turn is still running')))
}

// ── update-state progress is reported for the flow's request id ────────────
{
  let listener: ((progress: { requestId: string; step: 'checking' | 'removing' | 'installing' | 'restoring' }) => void) | undefined
  const fake = fakeManager({
    bundles: [bundle('alpha')],
    listings: {
      alpha: {
        installed: '1.0.0', registry: 'https://registry.example',
        versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }],
      },
    },
  })
  const original = fake.manager.updateBundle.bind(fake.manager)
  fake.manager.updateBundle = async (name, version, updateOptions) => {
    if (updateOptions?.requestId !== undefined) listener?.({ requestId: updateOptions.requestId, step: 'installing' })
    return original(name, version, updateOptions)
  }
  const { flow, lines } = runUpdate(fake.manager, [], false, {
    onState: callback => { listener = callback; return () => { listener = undefined } },
  })
  await flow.run()
  check('progress is reported', lines.some(line => line.includes('installing the new version')), lines.join('\n'))
}

// ── Failure and restore are both reported; the flow never rejects ──────────
{
  const fake = fakeManager({
    bundles: [bundle('alpha')],
    listings: {
      alpha: {
        installed: '1.0.0', registry: 'https://registry.example',
        versions: [{ version: '1.1.0', tags: ['latest'], prerelease: false, bundle: true }],
      },
    },
    result: () => ({
      from: '1.0.0', to: '1.1.0', step: 'install',
      result: { changed: false, application: 'failed', stage: 'install', target: 'alpha', error: { code: 'operation-error' } },
      restore: { changed: true, application: 'applied', stage: 'install', target: 'alpha@1.0.0' },
    }),
  })
  const { flow, lines } = runUpdate(fake.manager, [])
  await flow.run()
  check('failure is reported', lines.some(line => line.includes('update failed') && line.includes('operation-error')))
  check('restored version is reported', lines.some(line => line.includes('restored the previous version 1.0.0')))
  check('failed count is reported', lines.some(line => line.includes('1 failed')), lines.join('\n'))
}

// ── A registry lookup failure counts as failed, not as "current" ───────────
{
  const fake = fakeManager({
    bundles: [bundle('alpha')],
    listings: { alpha: { refused: 'registry unreachable', problem: 'network' } },
  })
  const { flow, lines } = runUpdate(fake.manager, [])
  await flow.run()
  check('lookup failure is reported', lines.some(line => line.includes('update failed') && line.includes('registry unreachable')))
  check('lookup failure counts as failed', lines.some(line => line.includes('1 failed')), lines.join('\n'))
}

// ── An older host without the update API gets a sentence, not a TypeError ──
{
  const legacy = { listBundles: async () => [] } as unknown as PluginManagerView
  const { flow, lines } = runUpdate(legacy, [])
  await flow.run()
  check('missing update API is reported as unavailable',
    lines.some(line => line.includes('does not expose')), lines.join('\n'))
}

console.log(`verify-plugin-update OK (${checks} checks)`)
