/**
 * The host side of a backend's OAuth credential (`BackendHost.oauthCredential`,
 * docs/agent-backend-design.md §4.12): the dsh-auth credential file, read and
 * refreshed through dsh-auth's own public pieces — `CredentialFile` (whose
 * `modify` serializes a refresh across requests and processes) and the
 * provider's pi-ai OAuth flow (`refresh`). Nothing here runs a login (that
 * stays dsh-auth's `/login` wizard) or logs token material.
 *
 * The file is the dsh-auth default location (`$DSH_AUTH_CREDENTIALS`, else
 * `$DSH_HOME/dsh-auth/credentials.json`, else `~/.dsh/…`); a custom
 * `credentialsFile` in the dsh-auth config row is not visible to this module
 * — set `DSH_AUTH_CREDENTIALS` to the same path.
 *
 * The pi-ai catalog is loaded only when a refresh is actually due: a backend
 * session whose token is still fresh never pays for it.
 *
 * A refresh is compare-and-swap: due only while the stored token is about to
 * expire or is still the one the backend refused, re-checked under the
 * credential file's lock right before the network call. Residual race: a
 * writer that rotates the token WITHOUT that lock (outside dsh-auth's
 * `CredentialFile`) can still interleave with a refresh here; closing it
 * would need dsh-auth itself to version its credentials.
 */
import type { OAuthAccess, OAuthCredentialSource } from '../agent/backend.js'
import { asStoredCredential, CredentialFile, defaultCredentialsFile, type StoredOAuthCredential } from './oauth/credentials.js'

/** One token refresh (default: the provider's own pi-ai OAuth flow). */
export type OAuthRefresh = (provider: string, credential: StoredOAuthCredential, signal: AbortSignal) => Promise<StoredOAuthCredential>

/** The provider's pi-ai OAuth `refresh`, loaded on first use. */
const piAiRefresh: OAuthRefresh = async (provider, credential, signal) => {
  const [{ adapterBuiltinProviders }, { oauthOf }] = await Promise.all([
    import('./oauth/pi-ai.js'),
    import('./oauth/profiles.js'),
  ])
  const route = adapterBuiltinProviders().find(candidate => candidate.id === provider)
  if (route === undefined) throw new Error(`dsh-auth: the installed pi-ai catalog ships no provider "${provider}"`)
  const refreshed = asStoredCredential(await oauthOf(route).refresh(credential, signal))
  if (refreshed === undefined) throw new Error(`dsh-auth: the ${provider} refresh returned an unusable credential`)
  return refreshed
}

/** Refresh this long before the token expires (a turn must not start on a
 *  token that dies mid-request). */
const REFRESH_MARGIN_MS = 5 * 60_000
/** Bound on one refresh round trip. */
const REFRESH_TIMEOUT_MS = 60_000

/** The dsh-auth credential of one provider as a backend credential source. */
export function createOAuthCredentialSource(
  provider: string,
  options: { readonly file?: string; readonly now?: () => number; readonly refresh?: OAuthRefresh } = {},
): OAuthCredentialSource {
  const store = new CredentialFile(options.file ?? defaultCredentialsFile())
  const now = options.now ?? Date.now
  const refresh = options.refresh ?? piAiRefresh
  const access = (value: unknown): OAuthAccess | undefined => {
    const credential = asStoredCredential(value)
    return credential === undefined ? undefined : { access: credential.access, expires: credential.expires }
  }
  return {
    async stored(): Promise<boolean> {
      return access(await store.read(provider)) !== undefined
    },
    async fresh(request = {}): Promise<OAuthAccess | undefined> {
      // Due: about to expire, or still the very token the backend refused.
      // A token that differs from the refused one was rotated by someone
      // else (a fresh `/login`, another request's refresh): use it as is.
      const due = (credential: OAuthAccess): boolean =>
        credential.expires - now() <= REFRESH_MARGIN_MS ||
        (request.rejected !== undefined && credential.access === request.rejected)
      const current = access(await store.read(provider))
      if (current === undefined) return undefined
      if (!due(current)) return current
      // Re-read and refresh under the file's own lock (compare-and-swap): a
      // concurrent dsh-auth request or another process that already rotated
      // the token wins, and its credential is what comes back.
      const next = await store.modify(provider, async stored => {
        const credential = asStoredCredential(stored)
        if (credential === undefined) return undefined
        if (!due({ access: credential.access, expires: credential.expires })) return undefined
        return refresh(provider, credential, AbortSignal.timeout(REFRESH_TIMEOUT_MS))
      })
      return access(next)
    },
  }
}
