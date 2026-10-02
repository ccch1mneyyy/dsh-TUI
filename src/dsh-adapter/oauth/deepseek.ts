/**
 * TUI interaction for the Host-owned DeepSeek account authorization flow.
 *
 * The Host owns PKCE, its callback route, credential persistence, and the
 * `deepseek-account` LLM route. This module supplies a loopback callback
 * origin, mounts the official Host listener when an older bundle patch omits
 * it, and displays the Host's safe attempt state through the existing question
 * panel. It never reads or writes the account grant.
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountClientMetadata, AccountView, DeepSeekAccount, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { getLang } from '../../i18n.js'
import { QuestionBridge, type AskFn, type QuestionBridgeHelpers } from './interaction.js'

export const DEEPSEEK_ACCOUNT_PROVIDER = 'deepseek-account'

/** Only the account operations this interaction surface consumes. */
export type DeepSeekAccountAuth = Pick<DeepSeekAccount, 'getState' | 'startSignIn' | 'cancelSignIn' | 'signOut' | 'watch'>
  & Partial<Pick<DeepSeekAccount, 'getUnnotifiedBonuses' | 'ackBonusNotified'>>

/** Resolve late: the account provider is absent on older DSH hosts. */
export function deepSeekAccountFrom(ctx: Context): DeepSeekAccountAuth | undefined {
  return ctx.get('deepseekAccount')
}

/** The Host webServer may be shared, supplied by the TUI row, or mounted as a fallback. */
export function deepSeekCallbackOrigin(ctx: Context): string {
  const server: WebServer | undefined = ctx.get('webServer')
  const port = server?.port
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DeepSeek sign-in needs an active Host webServer for the browser callback')
  }
  return `http://127.0.0.1:${port}`
}

/**
 * Keep DeepSeek login usable after a profile-only update from a global TUI
 * whose older bundle patch still mounts `dsh-tui-auth` but has no webserver
 * row. The official Host listener is mounted only on the first login that
 * needs it; an existing Web or user-owned listener is never replaced.
 */
export function createDeepSeekCallbackOriginResolver(ctx: Context): {
  resolve(): Promise<string>
  dispose(): Promise<void>
} {
  let fallback: { dispose(): Promise<void> } | undefined
  let mounting: Promise<void> | undefined
  let disposed = false

  const mountFallback = async (): Promise<void> => {
    const { WebServer } = await import('@deepseek-ai/dsh-host-webserver')
    if (disposed) throw new Error('dsh-auth: callback listener owner was disposed')
    // Another Host row may have become available while the import resolved.
    if (ctx.get('webServer') !== undefined) return
    const fiber = ctx.root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    fallback = fiber
    try {
      await fiber
    } catch (error) {
      fallback = undefined
      try {
        await fiber.dispose()
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], 'DeepSeek callback listener failed to start and dispose')
      }
      throw error
    }
  }

  return {
    resolve: async () => {
      if (disposed) throw new Error('dsh-auth: callback listener owner was disposed')
      if (ctx.get('webServer') === undefined) {
        // A declared but unavailable listener is a composition decision or
        // failure, not the missing row of an older global TUI patch.
        const loader = ctx.get('loader') as {
          entries(): Iterable<{ options: { id?: string; name?: string } }>
        } | undefined
        for (const entry of loader?.entries() ?? []) {
          if (entry.options.id === 'dsh-tui-webserver'
            || entry.options.name === '@deepseek-ai/dsh-host-webserver') {
            return deepSeekCallbackOrigin(ctx)
          }
        }
        mounting ??= mountFallback().finally(() => { mounting = undefined })
        try {
          await mounting
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`DeepSeek sign-in could not start a Host webServer callback listener: ${message}`, { cause: error })
        }
      }
      if (disposed) throw new Error('dsh-auth: callback listener owner was disposed')
      return deepSeekCallbackOrigin(ctx)
    },
    dispose: async () => {
      disposed = true
      await mounting?.catch(() => undefined)
      await fallback?.dispose()
      fallback = undefined
    },
  }
}

const tuiVersion = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL(import.meta.resolve('@deepseek-harness-tui/dsh-tui/package.json')), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Platform request identity is supplied by the current TUI, not cached by the Host. */
export function deepSeekClientMetadata(): AccountClientMetadata {
  return {
    version: tuiVersion,
    locale: getLang() === 'zh' ? 'zh-CN' : 'en-US',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

function succeeded(state: AccountView, id: SignInAttemptId): boolean {
  return state.attempt?.id === id && state.attempt.phase === 'succeeded' && state.status === 'credential-stored'
}

/**
 * Start (or join) the upstream browser attempt, display its URL, and wait for
 * the upstream state stream. Esc/external abort cancels the exact attempt;
 * a commit that won that race is reported as success instead of a false
 * cancellation. The question panel is always retired before returning.
 */
export async function loginDeepSeekAccount(
  account: DeepSeekAccountAuth,
  callbackOrigin: string,
  ask: AskFn,
  signal?: AbortSignal,
  helpers: QuestionBridgeHelpers = {},
): Promise<void> {
  const runAbort = new AbortController()
  const forwardAbort = () => runAbort.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) forwardAbort()
    else signal.addEventListener('abort', forwardAbort, { once: true })
  }
  const bridge = new QuestionBridge(ask, runAbort, helpers)
  let id: SignInAttemptId | undefined
  let active = false
  try {
    runAbort.signal.throwIfAborted()
    // Match Desktop's login_source for Platform-side promotion eligibility.
    const initial = await account.startSignIn(deepSeekClientMetadata(), callbackOrigin, 'desktop')
    id = initial.attempt?.id
    if (id === undefined) throw new Error('DeepSeek sign-in returned no attempt')
    active = true
    runAbort.signal.throwIfAborted()
    let shownUrl: string | undefined
    try {
      for await (const state of account.watch(runAbort.signal)) {
        const attempt = state.attempt
        if (attempt?.id !== id) throw new Error('DeepSeek sign-in attempt was replaced')
        if (attempt.phase === 'waiting-browser' && attempt.authorizeUrl !== undefined
          && attempt.authorizeUrl !== shownUrl) {
          shownUrl = attempt.authorizeUrl
          bridge.notify({ type: 'auth_url', url: shownUrl })
        }
        if (attempt.phase === 'succeeded') {
          active = false
          if (!succeeded(state, id)) throw new Error('DeepSeek sign-in succeeded without a stored credential')
          return
        }
        if (attempt.phase === 'failed' || attempt.phase === 'expired' || attempt.phase === 'cancelled') {
          active = false
          throw new Error(`DeepSeek sign-in ${attempt.phase}${attempt.errorCode === undefined ? '' : ` (${attempt.errorCode})`}`)
        }
      }
    } catch (error: unknown) {
      if (!runAbort.signal.aborted) throw error
    }
    if (runAbort.signal.aborted) {
      const afterCancel = await account.cancelSignIn(id)
      active = false
      if (succeeded(afterCancel, id)) return
      throw new Error('DeepSeek sign-in cancelled')
    }
    throw new Error('DeepSeek sign-in state stream ended before completion')
  } finally {
    signal?.removeEventListener('abort', forwardAbort)
    runAbort.abort()
    try {
      if (active && id !== undefined) await account.cancelSignIn(id)
    } finally {
      await bridge.settle()
    }
  }
}
