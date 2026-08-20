/**
 * Background auto-refresh for the xAI (Grok/X subscription) route added by
 * the `/provider` wizard. The subscription's access token dies hourly; the
 * refresher keeps the harness credential store's value fresh so every
 * request resolves a live token (the llm-pi-ai adapter reads `apiKeyEnv` per
 * request, so a refresh lands on the next request with no restart).
 *
 * Refreshes only while the whole chain is still alive: the record exists,
 * the route profile still exists in `llm-pi-ai` settings, the credential
 * store still holds the ref (a `/logout` or plain setting removal stops the
 * loop rather than resurrecting the route), and the ref is not shadowed by
 * the process environment (an env value is not writable here). Failures are
 * logged and retried on the next tick; nothing here reaches the UI.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  readXaiOAuthStore,
  refreshXaiCredential,
  writeXaiOAuthStore,
  type XaiOAuthStore,
} from './xaiOAuth.js'

/** How often the refresher evaluates the stored credential. */
const REFRESH_TICK_MS = 60 * 1000

/** Credential-ref resolution: the `dsh-credentials` seam's shape. */
interface CredentialSeam {
  resolve(ref: string): Promise<{ value?: unknown } | undefined>
  set(ref: string, value: string): Promise<void>
}

/** Settings-section read: the `dsh-settings` seam's shape. */
interface SettingsSeam {
  get(ns: string): unknown
}

/**
 * One refresh evaluation: read the store, decide whether a refresh is due,
 * and rotate the token into both the credential store and the refresh
 * record. Exported so the headless verify script can drive it with a fake
 * `ctx`; the ticker below is just this on an interval.
 * @param ctx - The plugin context; seams are resolved lazily so mount order
 *   never matters.
 * @param store - The refresh record to evaluate (defaults to the file).
 * @param storePath - Where to persist the rotated record (injectable for
 *   tests; defaults to the file the store was read from).
 */
export async function refreshXaiSubscriptionOnce(
  ctx: Context,
  store: XaiOAuthStore | undefined = readXaiOAuthStore(),
  storePath?: string,
): Promise<void> {
  if (store === undefined) return
  if (process.env[store.ref] !== undefined) return
  if (store.credential.expires - Date.now() > 0) return
  const credentials = ctx.get('credentials') as CredentialSeam | undefined
  if (credentials === undefined) return
  const settings = ctx.get('settings') as SettingsSeam | undefined
  if (settings !== undefined) {
    const section = settings.get('llm-pi-ai') as
      | { providers?: Record<string, unknown> }
      | undefined
    if (section?.providers === undefined || !(store.route in section.providers)) return
  }
  const resolved = await credentials.resolve(store.ref)
  if (resolved === undefined || resolved.value === undefined) return
  try {
    const fresh = await refreshXaiCredential(store.credential)
    await credentials.set(store.ref, fresh.access)
    writeXaiOAuthStore({ ...store, credential: fresh }, storePath)
    ctx.logger.info(
      `dsh-tui: xAI subscription token for "${store.route}" refreshed (valid until ${new Date(fresh.expires).toISOString()})`,
    )
  } catch (error) {
    ctx.logger.warn(
      `dsh-tui: xAI subscription token refresh for "${store.route}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * Start the xAI subscription refresher. Registered through `ctx.effect` by
 * the plugin; the returned disposer stops the ticker.
 * @param ctx - The plugin context.
 * @returns The disposer.
 */
export function startXaiSubscriptionRefresh(ctx: Context): () => void {
  const timer = setInterval(() => void refreshXaiSubscriptionOnce(ctx), REFRESH_TICK_MS)
  timer.unref?.()
  void refreshXaiSubscriptionOnce(ctx)
  return () => clearInterval(timer)
}
