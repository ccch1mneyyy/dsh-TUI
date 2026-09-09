import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider, LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { t } from '../../i18n.js'
import type { ChannelState } from '../channel/types.js'
import { isReservedCredentialRef } from '../credentialRefGuard.js'
import type { OAuthProviderStatus, OAuthSetupHost, ProfilePathOp, ProviderSetupHost } from '../providerWizard.js'
import type { SettingsHost } from '../settingsEditor.js'

export function createSettingsHosts(ctx: Context, assertActive: () => void = () => undefined): Pick<ChannelState, 'settingsHost' | 'providerSetup' | 'oauthProviderStatuses'> {
  let settingsHostResolved = false
  let settingsHostCache: SettingsHost | undefined
  return {

    settingsHost(): SettingsHost | undefined {
      if (settingsHostResolved) return settingsHostCache
      settingsHostResolved = true
      // The `/settings` screen's runtime surface, over the same dsh-base
      // seams the `/provider` wizard uses: settings (namespace descriptors +
      // revision-fenced mutate) and credentials (secret writes). Structurally
      // typed like the other optional seams in this file.
      const settings = ctx.get('settings') as
        | {
          describe(options?: { redactSecrets?: boolean }): readonly {
            ns: string
            revision: number
            applies: 'live' | 'restart'
            value: unknown
            user?: unknown
          }[]
          mutate(
            ns: string,
            ops: readonly (
              | { op: 'set'; path: readonly string[]; value: unknown }
              | { op: 'unset'; path: readonly string[] }
            )[],
            expectedRevision?: number,
          ): Promise<void>
        }
        | undefined
      const credentials = ctx.get('credentials') as
        | {
          resolve(ref: string): Promise<{ value: string } | undefined>
          set(ref: string, value: string): Promise<void>
        }
        | undefined
      if (!settings) return undefined
      settingsHostCache = {
        listNamespaces() {
          // redactSecrets: the screen never renders a secret literal — secret
          // fields are write-only controls over the credentials seam.
          return settings.describe({ redactSecrets: true }).map(descriptor => ({
            ns: descriptor.ns,
            revision: descriptor.revision,
            applies: descriptor.applies,
            value: descriptor.value,
            user: descriptor.user,
          }))
        },
        write(ns, ops, expectedRevision) {
          return settings.mutate(ns, ops, expectedRevision)
        },
        async credentialConfigured(ref) {
          // The environment shadows the store (providerSetup.envShadows), so
          // an env-provided key counts as configured.
          if (process.env[ref] !== undefined) return true
          return credentials !== undefined && (await credentials.resolve(ref)) !== undefined
        },
        async writeCredential(ref, value) {
          if (!credentials) throw new Error('credentials service unavailable')
          // Second layer of the secret-ref reservation guard: the
          // registration layer already rejects plugin sections with
          // host-owned refs, but this seam must not trust it — a stale
          // section (registered before the guard) or a direct call must not
          // reach the shared credentials. The host's own main-credential
          // writes go through providerSetup().writeCredential instead.
          if (isReservedCredentialRef(ref)) throw new Error(t('settings-secret-ref-reserved', { ref }))
          await credentials.set(ref, value)
        },
      }
      return settingsHostCache
    },

    providerSetup(): ProviderSetupHost | undefined {
      // The `/provider` wizard's runtime surface, over the dsh-base seams:
      // settings (profile persistence), credentials (key storage) and the
      // llm runtime's configurable-provider directory + model discovery.
      // Structurally typed like the other optional seams in this file.
      const llm = ctx.get('llm') as
        | {
          listConfigurableProviders(): readonly LlmConfigurableProvider[]
          discoverModels(
            settingsNs: string,
            request: {
              provider?: string
              baseURL?: string
              api?: string
              apiKey?: string
            },
          ): Promise<readonly LlmDiscoveredModel[]>
        }
        | undefined
      const settings = ctx.get('settings') as
        | {
          describe(): readonly { ns: string; revision: number; user?: unknown }[]
          get(ns: string): unknown
          mutate(
            ns: string,
            ops: readonly (
              | { op: 'set'; path: readonly string[]; value: unknown }
              | { op: 'unset'; path: readonly string[] }
            )[],
            expectedRevision?: number,
          ): Promise<void>
        }
        | undefined
      const credentials = ctx.get('credentials') as
        | {
          resolve(ref: string): Promise<{ value: string } | undefined>
          set(ref: string, value: string): Promise<void>
          unset(ref: string): Promise<void>
        }
        | undefined
      // Without dsh-llm-pi-ai there is no adapter watching the settings
      // section, so a written profile would never activate a route. The
      // adapter registers its `llm-pi-ai` settings namespace at mount, which
      // is the rc.6-observable mount signal (the newer
      // `listModelDiscoveryNamespaces()` does not exist in rc.6).
      if (!llm || !settings || !credentials
        || !settings.describe().some(descriptor => descriptor.ns === 'llm-pi-ai')) {
        return undefined
      }
      const revision = (): number | undefined =>
        settings.describe().find(descriptor => descriptor.ns === 'llm-pi-ai')?.revision
      // The OAuth sign-in surface (dsh-auth-style plugin), structural and
      // optional: mounting the plugin lights up the wizard's OAuth branch,
      // and without it the wizard is exactly what it was before.
      const oauthApi = (ctx.get('dshAuth') as { api?: OAuthSetupHost } | undefined)?.api
      // Real catalog membership on this mount: routes the adapter knows from
      // its installed catalog (`declared !== true`). A stored profile naming
      // such a route is an activation/override of the catalog route — even
      // when it carries an explicit `api` field — while routes the adapter
      // only knows because a profile names them are custom. Classifying by
      // anything less (a profile-shape guess) misroutes the edit semantics.
      const catalogMembers = (): Set<string> => new Set(
        llm.listConfigurableProviders()
          .filter(entry => entry.settingsNs === 'llm-pi-ai' && entry.declared !== true)
          .map(entry => entry.provider),
      )
      return {
        ...(oauthApi === undefined ? {} : { oauth: oauthApi }),
        listCatalogProviders() {
          // declared === true marks routes the adapter knows only because a
          // stored profile names them (user-added); the rest are activatable
          // catalog routes.
          return llm.listConfigurableProviders()
            .filter(entry => entry.settingsNs === 'llm-pi-ai' && entry.declared !== true)
            .map(entry => ({ provider: entry.provider, displayName: entry.displayName }))
        },
        routeExists(route) {
          const section = settings.get('llm-pi-ai') as
            | { providers?: Record<string, unknown> }
            | undefined
          return section?.providers !== undefined && route in section.providers
        },
        listRefUsers(ref, exceptRoute) {
          // The RESOLVED merge (settings.get), not the user layer: a base
          // provider or composition-base route naming this ref is invisible
          // to listConfiguredProviders() but still consumes the credential.
          const section = settings.get('llm-pi-ai') as
            | { providers?: Record<string, unknown> }
            | undefined
          const providers = section?.providers
          if (providers === undefined || typeof providers !== 'object' || providers === null) return []
          return Object.entries(providers).flatMap(([route, profile]) => {
            if (route === exceptRoute) return []
            if (typeof profile !== 'object' || profile === null) return []
            const stored = profile as Record<string, unknown>
            return stored.apiKeyEnv === ref ? [route] : []
          })
        },
        listConfiguredProviders() {
          // The editable/deletable set is the USER layer only: `describe()`'s
          // `user` is the raw user section — the same source the /settings
          // screen treats as overrides. `settings.get()` is the resolved
          // merge; listing a route inherited from a composition base would
          // promise a delete that cannot land (the unset only clears the
          // user layer, so the base value re-inherits) while the credential
          // is really gone. When the running base exposes no `user` layer,
          // fall back to the resolved section: such builds (the official
          // dsh-base) carry zero base routes anyway, so the layers coincide.
          const descriptor = settings.describe().find(row => row.ns === 'llm-pi-ai')
          // Only an absent `user` (older base) falls back; a present-but-empty
          // user layer legitimately exposes nothing to edit.
          const section = (descriptor?.user !== undefined
            ? descriptor.user
            : settings.get('llm-pi-ai')) as
            | { providers?: Record<string, unknown> }
            | undefined
          const providers = section?.providers
          if (providers === undefined || typeof providers !== 'object' || providers === null) return []
          const catalog = catalogMembers()
          return Object.entries(providers).flatMap(([route, profile]) => {
            // The settings section is user-editable, so a `providers.<route>`
            // entry may be null or a scalar; skip anything that is not a plain
            // object instead of dereferencing it and throwing (which would
            // block the edit/delete menu for every route).
            if (typeof profile !== 'object' || profile === null) return []
            const stored = profile as Record<string, unknown>
            const ref = typeof stored.apiKeyEnv === 'string' ? stored.apiKeyEnv : ''
            const baseURL = typeof stored.baseURL === 'string' && stored.baseURL !== ''
              ? stored.baseURL
              : undefined
            const api = typeof stored.api === 'string' && stored.api !== ''
              ? stored.api
              : undefined
            // Keep the raw model entries: a model-list re-selection must
            // rewrite kept ids with their stored objects, so per-model fields
            // this wizard never learned about survive the edit.
            const modelEntries = Array.isArray(stored.models)
              ? stored.models.filter(
                (model): model is Record<string, unknown> =>
                  typeof model === 'object' && model !== null,
              )
              : undefined
            const models = modelEntries?.flatMap(
              entry => typeof entry.id === 'string' ? [entry.id] : [],
            )
            return [{
              route,
              ref,
              isCatalog: catalog.has(route),
              shadowed: ref !== '' && process.env[ref] !== undefined,
              ...(baseURL !== undefined ? { baseURL } : {}),
              ...(api !== undefined ? { api } : {}),
              ...(models !== undefined ? { models } : {}),
              ...(modelEntries !== undefined && modelEntries.length > 0
                ? { modelEntries }
                : {}),
            }]
          })
        },
        discoverModels(request) {
          return llm.discoverModels('llm-pi-ai', request)
        },
        envShadows(ref) {
          return process.env[ref] !== undefined
        },
        envValue(ref) {
          return process.env[ref]
        },
        async readCredential(ref) {
          const resolved = await credentials.resolve(ref)
          return resolved?.value
        },
        writeCredential(ref, value) {
          return credentials.set(ref, value)
        },
        removeCredential(ref) {
          return credentials.unset(ref)
        },
        async writeProfile(route, profile) {
          const ops = [{ op: 'set' as const, path: ['providers', route], value: profile }]
          try {
            assertActive()
            await settings.mutate('llm-pi-ai', ops, revision())
          } catch (error) {
            // One retry on a stale-revision conflict (a concurrent write
            // landed between describe and mutate); anything else propagates
            // so the wizard can report and roll back the credential.
            const code = (error as { code?: unknown })?.code
            if (code !== 'SETTINGS_CONFLICT') throw error
            assertActive()
            await settings.mutate('llm-pi-ai', ops, revision())
          }
        },
        async mutateProfile(route, ops) {
          // Route-relative path patch: only the addressed fields inside
          // `providers.<route>` enter the write, so stored fields the TUI
          // does not model never pass through here and cannot be dropped.
          const full: readonly ProfilePathOp[] = ops.map(op => op.op === 'set'
            ? { op: 'set', path: ['providers', route, ...op.path], value: op.value }
            : { op: 'unset', path: ['providers', route, ...op.path] })
          try {
            assertActive()
            await settings.mutate('llm-pi-ai', full, revision())
          } catch (error) {
            // Same stale-revision retry as writeProfile.
            const code = (error as { code?: unknown })?.code
            if (code !== 'SETTINGS_CONFLICT') throw error
            assertActive()
            await settings.mutate('llm-pi-ai', full, revision())
          }
        },
        async removeProfile(route) {
          const ops = [{ op: 'unset' as const, path: ['providers', route] }]
          try {
            assertActive()
            await settings.mutate('llm-pi-ai', ops, revision())
          } catch (error) {
            // Same stale-revision retry as writeProfile: the wizard reports
            // any real failure so the credential deletion can be skipped.
            const code = (error as { code?: unknown })?.code
            if (code !== 'SETTINGS_CONFLICT') throw error
            assertActive()
            await settings.mutate('llm-pi-ai', ops, revision())
          }
        },
      }
    },

    async oauthProviderStatuses(): Promise<readonly OAuthProviderStatus[] | undefined> {
      // Same optional seam the wizard's OAuth branch reads: absent plugin →
      // undefined, and `/login` renders exactly its pre-plugin lines.
      const api = (ctx.get('dshAuth') as { api?: OAuthSetupHost } | undefined)?.api
      return api === undefined ? undefined : api.providers()
    }
  }
}
