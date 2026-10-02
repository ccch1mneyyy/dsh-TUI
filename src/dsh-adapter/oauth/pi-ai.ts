/**
 * The pi-ai instance owned by the installed dsh-llm-pi-ai adapter.
 *
 * Different host prereleases can depend on different pi-ai versions. Loading
 * a second catalog in this module and handing its Provider objects to the
 * adapter crosses package instances and is neither type- nor runtime-safe.
 * Resolve the adapter's own dependency instead, and derive every public type
 * from the adapter contract so this package owns no pi-ai version.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

// 0.1.5 made `piProvider` optional (absent when a stored route cannot be
// constructed); this package only ever handles constructible catalog
// providers, so the shared alias is the non-nullable form. NonNullable is a
// no-op against pre-0.1.5 typings, keeping one source for both generations.
export type PiAiProvider = NonNullable<ResolvedPiAiProviderProfile['piProvider']>

type PiAiAuth = PiAiAdapterOptions['auth']
export type PiAiAuthContext = PiAiAuth['authContext']
export type PiAiCredentialStore = PiAiAuth['credentials']
export type PiAiCredential = NonNullable<Awaited<ReturnType<PiAiCredentialStore['read']>>>
export type PiAiCredentialInfo = Awaited<ReturnType<PiAiCredentialStore['list']>>[number]

type PiAiOAuth = NonNullable<PiAiProvider['auth']['oauth']>
export type PiAiAuthInteraction = Parameters<PiAiOAuth['login']>[0]
export type PiAiAuthPrompt = Parameters<PiAiAuthInteraction['prompt']>[0]
export type PiAiAuthEvent = Parameters<PiAiAuthInteraction['notify']>[0]

/** pi-ai 0.87.1 added this optional login context; older flows ignore it. */
export interface PiAiLoginOptions {
  getDeviceId?: () => string
}

/** Keep the optional second argument compatible with older adapter typings. */
export function loginOAuth(
  oauth: PiAiOAuth,
  interaction: PiAiAuthInteraction,
  options: PiAiLoginOptions,
): ReturnType<PiAiOAuth['login']> {
  const compatible = oauth as PiAiOAuth & {
    login(interaction: PiAiAuthInteraction, options?: PiAiLoginOptions): ReturnType<PiAiOAuth['login']>
  }
  return compatible.login(interaction, options)
}

interface ProviderCatalogModule {
  builtinProviders(): readonly PiAiProvider[]
}

/** Locate the first pi-ai catalog Node would resolve from dsh-llm-pi-ai. */
function adapterCatalogUrl(): string {
  const adapterManifest = import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
  const require = createRequire(adapterManifest)
  for (const root of require.resolve.paths('@earendil-works/pi-ai') ?? []) {
    const catalog = join(root, '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js')
    if (existsSync(catalog)) return pathToFileURL(catalog).href
  }
  throw new Error('dsh-auth: dsh-llm-pi-ai has no resolvable pi-ai provider catalog')
}

const catalog = await import(adapterCatalogUrl()) as ProviderCatalogModule

/** Fresh Provider objects from the exact pi-ai module used by dsh-llm-pi-ai. */
export const adapterBuiltinProviders = catalog.builtinProviders
