/**
 * The `ctx.dshAuth` service: the programmatic surface over this module's
 * mounted OAuth routes. UIs (the dsh-tui /provider wizard, a web settings
 * page) enumerate providers with masked sign-in state and drive login/logout
 * without touching the credential file or the pi-ai flow objects; the `/auth`
 * command in `command.ts` is a thin textual veneer over the same api.
 *
 * @module @deepseek-harness-tui/dsh-tui/oauth/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { asStoredCredential, CredentialFile } from './credentials.js'
import { oauthOf } from './profiles.js'
import { QuestionBridge, type AskFn } from './interaction.js'
import { loginOAuth, type PiAiProvider } from './pi-ai.js'
import {
  DEEPSEEK_ACCOUNT_PROVIDER,
  deepSeekClientMetadata,
  loginDeepSeekAccount,
  type DeepSeekAccountAuth,
} from './deepseek.js'
import { WhaleCouponStore } from './bonus.js'

/**
 * The constructed catalog provider one mounted route carries. 0.1.5 made
 * `ResolvedPiAiProviderProfile.piProvider` optional (a stored route that
 * cannot be constructed stays editable without one); this plugin mounts only
 * constructible routes, so an absent provider here is a mount defect —
 * surfaced loudly rather than as an `undefined` dereference mid-flow.
 */
function mountedProvider(profile: ResolvedPiAiProviderProfile): PiAiProvider {
  if (profile.piProvider === undefined) {
    throw new Error(`dsh-auth: provider "${profile.provider}" mounted without a constructed catalog provider`)
  }
  return profile.piProvider
}

/** One provider's sign-in state; never carries token material. */
export interface DshAuthSignInStatus {
  provider: string
  /** Route display name (selectors, pickers). */
  label: string
  /** The OAuth flow's own name, e.g. "OpenAI (ChatGPT Plus/Pro)". */
  oauthLabel: string
  /** The flow's login-call-to-action label, when it ships one. */
  loginLabel: string | undefined
  signedIn: boolean
  expiresAt: number | undefined
  /** Signed in, but the stored access token has expired (refresh may still work). */
  expired: boolean
}

/** The outcome of a successful login. */
export interface DshAuthLoginResult {
  provider: string
  oauthLabel: string
  /** pi-ai tokens expire; the Host-owned DeepSeek account grant has no expiry. */
  expiresAt: number | undefined
}

/** The service api consumed by commands and UIs. */
export interface DshAuthApi {
  /** Every mounted provider with masked sign-in state. */
  providers(): Promise<readonly DshAuthSignInStatus[]>
  /**
   * Run one provider's OAuth login. `provider` omitted asks the interactive
   * surface to choose among providers not currently signed in.
   * @throws Error when no interactive surface is present, the provider is
   *   unknown, a login is already running, or the flow itself fails.
   */
  login(provider?: string, signal?: AbortSignal): Promise<DshAuthLoginResult>
  /** Cancel an active sign-in and remove the stored credential; resolves whether one existed. */
  logout(provider: string): Promise<boolean>
}

/** Cordis service holder; `api` is set by the plugin's apply. */
export class DshAuthService extends Service {
  api: DshAuthApi | undefined
  readonly coupons = new WhaleCouponStore()

  constructor(ctx: Context) {
    super(ctx, 'dshAuth')
  }
}

/** Everything the api factory needs; all cordis surface is injected, so tests run without a host. */
export interface DshAuthApiDeps {
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  store: CredentialFile
  /** The interactive ask surface, resolved per call so mounting order never matters. */
  resolveAsk: () => AskFn | undefined
  /** Optional upstream account service; older hosts have only pi-ai routes. */
  resolveDeepSeekAccount?: () => DeepSeekAccountAuth | undefined
  /** The active Host callback listener's browser-accessible loopback origin. */
  resolveCallbackOrigin?: () => string | Promise<string>
  coupons?: WhaleCouponStore
}

/** Select a provider interactively among `candidates`. */
async function chooseProvider(ask: AskFn, candidates: readonly DshAuthSignInStatus[], signal: AbortSignal | undefined): Promise<string> {
  const answer = await ask({
    questions: [{
      id: 'dsh-auth-provider',
      header: 'dsh-auth',
      question: 'Sign in with which provider?',
      options: candidates.map(row => ({ label: row.oauthLabel, description: row.provider })),
    }],
    signal,
  })
  const row = answer.answers[0]
  const label = row?.selected[0]
  const chosen = candidates.find(candidate => candidate.oauthLabel === label)
  if (chosen === undefined) throw new Error('dsh-auth: no provider was chosen')
  return chosen.provider
}

/**
 * The api implementation. One login runs per provider at a time (an in-flight
 * map, not a global lock: providers sign in independently); a second login
 * attempt for the same provider fails fast instead of stacking two flows.
 */
export function createDshAuthApi(deps: DshAuthApiDeps): DshAuthApi {
  const inflight = new Map<string, AbortController>()
  const mountedIds = (): string[] => [
    ...deps.profiles.keys(),
    ...(deps.resolveDeepSeekAccount?.() === undefined ? [] : [DEEPSEEK_ACCOUNT_PROVIDER]),
  ]

  const statusOf = async (): Promise<readonly DshAuthSignInStatus[]> => {
    const described = new Map((await deps.store.describe()).map(row => [row.provider, row]))
    const piAi = [...deps.profiles.entries()].map(([id, profile]) => {
      const oauth = oauthOf(mountedProvider(profile))
      const row = described.get(id)
      return {
        provider: id,
        label: profile.displayName,
        oauthLabel: oauth.name,
        loginLabel: oauth.loginLabel,
        signedIn: row !== undefined && !row.expired,
        expiresAt: row?.expiresAt,
        expired: row?.expired ?? false,
      }
    })
    const account = deps.resolveDeepSeekAccount?.()
    if (account === undefined) return piAi
    const state = await account.getState()
    return [{
      provider: DEEPSEEK_ACCOUNT_PROVIDER,
      label: 'DeepSeek Account',
      oauthLabel: 'DeepSeek',
      loginLabel: 'Sign in with DeepSeek',
      signedIn: state.status === 'credential-stored',
      expiresAt: undefined,
      expired: false,
    }, ...piAi]
  }

  const loginOne = async (provider: string, ask: AskFn, signal: AbortSignal | undefined): Promise<DshAuthLoginResult> => {
    const profile = deps.profiles.get(provider)
    if (profile === undefined) {
      throw new Error(`dsh-auth: unknown provider "${provider}" (mounted: ${mountedIds().join(', ')})`)
    }
    const oauth = oauthOf(mountedProvider(profile))
    const runAbort = new AbortController()
    const forwardAbort = () => runAbort.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) forwardAbort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const bridge = new QuestionBridge(ask, runAbort)
    try {
      runAbort.signal.throwIfAborted()
      const returned = await loginOAuth(oauth, bridge, {
        // pi-ai 0.87.1's `openai` flow needs this on login. Older flows
        // ignore the optional context, so the ID is created only on demand.
        getDeviceId: () => deps.store.getOrCreateDeviceId(),
      })
      const normalized = asStoredCredential(returned)
      if (normalized === undefined) {
        throw new Error(`dsh-auth: the ${oauth.name} flow returned an unusable credential; nothing was stored`)
      }
      await deps.store.modify(provider, async () => {
        // Logout may have cancelled the flow while this write waited for the file lock.
        runAbort.signal.throwIfAborted()
        return normalized
      })
      return { provider, oauthLabel: oauth.name, expiresAt: normalized.expires }
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
      await bridge.settle()
    }
  }

  return {
    providers: statusOf,
    login: async (provider, signal) => {
      const ask = deps.resolveAsk()
      let target = provider
      if (target === undefined) {
        if (ask === undefined) {
          throw new Error('dsh-auth: provider selection needs an interactive surface; name the provider: /auth login <provider>')
        }
        const statuses = await statusOf()
        const candidates = statuses.filter(row => !row.signedIn)
        if (candidates.length === 0) throw new Error('dsh-auth: every mounted provider is already signed in')
        target = await chooseProvider(ask, candidates, signal)
      } else if (!mountedIds().includes(target)) {
        throw new Error(`dsh-auth: unknown provider "${target}" (mounted: ${mountedIds().join(', ')})`)
      }
      if (ask === undefined) {
        throw new Error(
          `dsh-auth: signing in to "${target}" needs an interactive surface (run inside dsh-tui or the web client); `
          + 'this plugin refuses to assume a browser on this machine',
        )
      }
      if (inflight.has(target)) {
        throw new Error(`dsh-auth: a login for "${target}" is already running`)
      }
      const account = target === DEEPSEEK_ACCOUNT_PROVIDER ? deps.resolveDeepSeekAccount?.() : undefined
      if (target === DEEPSEEK_ACCOUNT_PROVIDER && account === undefined) {
        throw new Error(`dsh-auth: provider "${target}" is no longer mounted`)
      }
      const cancellation = new AbortController()
      const runSignal = signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal])
      inflight.set(target, cancellation)
      const run = (account === undefined
        ? loginOne(target, ask, runSignal)
        : (async (): Promise<DshAuthLoginResult> => {
          runSignal.throwIfAborted()
          const callbackOrigin = await deps.resolveCallbackOrigin?.()
          runSignal.throwIfAborted()
          if (callbackOrigin === undefined) {
            throw new Error('DeepSeek sign-in needs an active Host webServer for the browser callback')
          }
          await loginDeepSeekAccount(account, callbackOrigin, ask, runSignal)
          deps.coupons?.clear()
          const getUnnotifiedBonuses = account.getUnnotifiedBonuses?.bind(account)
          const ackBonusNotified = account.ackBonusNotified?.bind(account)
          if (getUnnotifiedBonuses !== undefined && ackBonusNotified !== undefined) {
            void deps.coupons?.refresh({ getUnnotifiedBonuses, ackBonusNotified })
          }
          return { provider: target, oauthLabel: 'DeepSeek', expiresAt: undefined }
        })()
      ).finally(() => { inflight.delete(target) })
      return run
    },
    logout: async provider => {
      // A DeepSeek login may still be awaiting its callback listener, before
      // the Host has an attempt to cancel. Abort it before Host sign-out.
      inflight.get(provider)?.abort(new Error('Login cancelled'))
      if (provider === DEEPSEEK_ACCOUNT_PROVIDER) {
        const account = deps.resolveDeepSeekAccount?.()
        if (account !== undefined) {
          const existed = (await account.getState()).status === 'credential-stored'
          await account.signOut(deepSeekClientMetadata())
          deps.coupons?.clear()
          return existed
        }
      }
      if (!deps.profiles.has(provider)) {
        throw new Error(`dsh-auth: unknown provider "${provider}" (mounted: ${mountedIds().join(', ')})`)
      }
      const existed = (await deps.store.read(provider)) !== undefined
      await deps.store.delete(provider)
      return existed
    },
  }
}
