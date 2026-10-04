/** Credential reconnect flow and account status text for a Claude session. */
import type { AccountInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountView, SessionAuthView } from '../../../agent/capabilities.js'
import type { AgentEvent, AgentEventMeta } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { detectClaudeAuth, refreshFailureDebugDetail, type ClaudeAuthPlan } from '../auth.js'
import { accountView } from '../controls.js'
import type { ClaudeTranslator } from '../translate.js'
import type { ClaudeClock, ClaudeSessionDeps, Run } from './types.js'

/** A failed credential renewal, carrying only its user-facing sentence. */
class RenewalFailed extends Error {}

export function createSessionAuth(context: {
  readonly deps: ClaudeSessionDeps
  readonly clock: ClaudeClock
  readonly translator: ClaudeTranslator
  readonly pushed: Map<string, SDKUserMessage>
  readonly idleWaiters: { resolve(): void; reject(error: Error): void }[]
  readonly run: Run
  readonly disposing: boolean
  authPlan: ClaudeAuthPlan
  readonly account: AccountInfo | undefined
  readonly apiKeySource: string | undefined
  idle(): boolean
  stopForReconnect(): { readonly unstarted: readonly string[] }
  openRun(): Promise<void>
  emit(events: readonly AgentEvent[], wake?: AgentEventMeta['wake']): void
  consume(target: Run): Promise<void>
  onExit(error: unknown): void
  stopRun(target: Run): void
}) {
  const { deps, clock, translator, pushed, idleWaiters, idle, stopForReconnect, openRun, emit, consume, onExit, stopRun } = context
  /** Automatic reconnects after an authentication failure since the last
   *  successful turn (one; after that the user is sent to /login). */
  let authAttempts = 0
  /**
   * Restart the CLI on the same session with a renewed credential: the old
   * CLI's prompts are withdrawn and an open turn closed, the
   * new query continues the session id, the translator keeps its state, and
   * the inputs the old CLI never started are pushed again, in order.
   *
   * After an authentication failure the old CLI is stopped first — before
   * the renewal awaits — so its queue cannot start (and fail on the refused
   * credential) meanwhile: every input it had not started is re-pushed. A
   * `/login` reconnect instead waits for the running turn and the inputs
   * queued behind it (submits keep going to the old CLI meanwhile), for at
   * most {@link RECONNECT_DEFER_MS}; then it reconnects anyway, saying that
   * it interrupts the turn.
   */
  let reconnecting: Promise<void> | undefined
  /** A `/login` reconnect is waiting for the session to go idle. */
  let reconnectDeferred = false
  const RECONNECT_DEFER_MS = deps.reconnectDeferMs ?? 120_000

  /** Wait (bounded) until no turn runs and nothing queued would start. */
  const waitIdleBounded = async (): Promise<void> => {
    if (idle()) return
    let timer: unknown
    const timedOut = await Promise.race([
      new Promise<false>((resolve, reject) => { idleWaiters.push({ resolve: () => resolve(false), reject }) }),
      new Promise<true>(resolve => { timer = clock.setTimeout(() => resolve(true), RECONNECT_DEFER_MS) }),
    ]).finally(() => clock.clearTimeout(timer))
    if (timedOut && !context.disposing) emit([{ type: 'notice', level: 'warning', text: t('claude-auth-reconnect-forced') }])
  }

  const reconnect = (renewal: { readonly rejected?: string }, options: { readonly waitIdle?: boolean } = {}): Promise<void> => {
    if (context.disposing) return Promise.reject(new Error(t('claude-session-closed')))
    reconnecting ??= (async (): Promise<void> => {
      const deferred = options.waitIdle === true
      let stopped = deferred ? undefined : stopForReconnect()
      let renewError: unknown
      // A deferred reconnect leaves the old CLI serving submits until it
      // actually swaps (renewal and the idle wait included).
      reconnectDeferred = deferred
      try {
        if (deps.auth !== undefined) {
          try {
            context.authPlan = await deps.auth.renew(renewal)
          } catch (error) {
            // Only the sanitized sentence leaves: the refresh error itself
            // can carry the OAuth endpoint's response body.
            const failure = new RenewalFailed(renewalFailed(error))
            // The old CLI is already gone: reconnect on the current
            // credential (its inputs still run), report the renewal after.
            if (stopped === undefined) throw failure
            renewError = failure
          }
        }
        if (deferred) await waitIdleBounded()
      } finally {
        reconnectDeferred = false
      }
      if (context.disposing) return
      stopped ??= stopForReconnect()
      const { unstarted } = stopped
      try {
        await openRun()
      } catch (error) {
        // Nothing can deliver them now: retire their previews, say so.
        const dropped = translator.dropInputs(unstarted)
        pushed.clear()
        if (dropped.length > 0) emit([...dropped, { type: 'notice', level: 'warning', text: t('claude-auth-inputs-dropped', { n: unstarted.length }) }])
        onExit(error)
        throw error
      }
      // A dispose during the handshake: the replacement must not outlive it.
      if (context.disposing) {
        stopRun(context.run)
        return
      }
      // Background work belonged to the old CLI process; the new one starts
      // with none (the level signal is per process).
      emit([{ type: 'tasks.snapshot', taskIds: [] }])
      const next = context.run
      const lost: string[] = []
      for (const uuid of unstarted) {
        const message = pushed.get(uuid)
        if (message === undefined) { lost.push(uuid); continue }
        // A fresh CLI is idle: each input is a plain push, in order.
        const { priority: _priority, ...plain } = message
        try {
          next.inbox.push(plain)
        } catch {
          lost.push(uuid)
        }
      }
      if (lost.length > 0) emit([...translator.dropInputs(lost), { type: 'notice', level: 'warning', text: t('claude-auth-inputs-dropped', { n: lost.length }) }])
      next.consumer = consume(next)
      if (renewError !== undefined) throw renewError
    })().finally(() => { reconnecting = undefined })
    return reconnecting
  }

  /** The token the live run spawned with, when it is the dsh-auth login. */
  const injectedToken = (): string | undefined =>
    context.authPlan.source === 'dsh-auth' ? context.authPlan.env.CLAUDE_CODE_OAUTH_TOKEN : undefined

  /** A failed renewal as the user sees it. The debug log gets a fixed
   *  failure category and at most the HTTP status: a real refresh rejection
   *  carries the OAuth endpoint's response body, which may echo request
   *  material (auth.ts contract) — the error's own text is never logged. */
  const renewalFailed = (error: unknown): string => {
    deps.host.debug(`claude: reconnect failed (${refreshFailureDebugDetail(error)})`)
    return deps.auth?.failureNotice?.(error) ?? t('claude-auth-reconnect-failed')
  }

  /** The CLI refused the credential: renew and resume once, then send the
   *  user to `/login` (never a loop of failing turns). */
  const onAuthFailure = (): void => {
    if (context.disposing) return
    if (authAttempts >= 1) {
      emit([{ type: 'notice', level: 'error', text: t('claude-auth-failed-login') }])
      return
    }
    authAttempts += 1
    reconnect({ rejected: injectedToken() }).then(() => {
      emit([{ type: 'notice', level: 'warning', text: t('claude-auth-reconnected') }])
    }, (error: unknown) => {
      emit([{ type: 'notice', level: 'error', text: error instanceof RenewalFailed ? error.message : renewalFailed(error) }])
    })
  }

  /** `/login` lines: where the credential comes from, never the token. */
  const authStatus = async (): Promise<SessionAuthView> => {
    const lines = [t('claude-auth-source', { source: authSourceLabel(context.authPlan) })]
    const route = routeLabel(context.authPlan)
    if (route !== undefined) lines.push(t('claude-auth-route', { route }))
    if (context.authPlan.source === 'claude-login' && await detectClaudeAuth(process.env, undefined) === 'missing' && context.account?.subscriptionType === undefined) {
      lines.push(t('claude-auth-missing-hint'))
    }
    lines.push(t('claude-auth-cli', { source: context.apiKeySource ?? t('doctor-unknown'), token: context.account?.tokenSource ?? t('doctor-unknown') }))
    if (context.account !== undefined) lines.push(...accountLines(accountView(context.account, context.apiKeySource)))
    return { lines }
  }
  return {
    reconnect,
    onAuthFailure,
    authStatus,
    get reconnecting() { return reconnecting },
    get reconnectDeferred() { return reconnectDeferred },
    get attempts() { return authAttempts },
    set attempts(value: number) { authAttempts = value },
  }
}

/** The `/login` and `/doctor` name of a credential source. */
export function authSourceLabel(plan: ClaudeAuthPlan): string {
  switch (plan.source) {
    case 'dsh-auth':
      return plan.expiresAt === undefined ? t('claude-auth-source-dsh-auth') : t('claude-auth-source-dsh-auth-expires', { time: new Date(plan.expiresAt).toISOString() })
    case 'api-key':
      return 'ANTHROPIC_API_KEY'
    case 'auth-token':
      return 'ANTHROPIC_AUTH_TOKEN'
    case 'oauth-env':
      return 'CLAUDE_CODE_OAUTH_TOKEN'
    case 'cloud':
      return t('claude-auth-source-cloud', { provider: plan.cloud ?? '' })
    case 'claude-login':
      return t('claude-auth-source-claude-login')
    default: {
      const unknown: never = plan.source
      return unknown
    }
  }
}

/** Why the subscription sign-in is not in use, when the route is not
 *  first-party (the origin host at most — never a full URL). */
function routeLabel(plan: ClaudeAuthPlan): string | undefined {
  const route = plan.route
  if (route === undefined) return undefined
  switch (route.kind) {
    case 'first-party':
    case 'cloud':
      return undefined
    case 'custom-endpoint':
      return t('claude-route-custom-endpoint', { host: route.host })
    case 'custom-oauth':
      return t('claude-route-custom-oauth')
    case 'unix-socket':
      return t('claude-route-unix-socket')
    case 'gateway':
      return t('claude-route-gateway')
    case 'api-key-helper':
      return t('claude-route-api-key-helper')
    case 'settings-unreadable':
      return t('claude-route-settings-unreadable')
    default: {
      const unknown: never = route
      return unknown
    }
  }
}

/** Account lines (never the email). */
export function accountLines(view: AccountView): string[] {
  const parts = [view.organization, view.subscription, view.provider].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? [] : [t('claude-auth-account', { account: parts.join(' · ') })]
}
