/**
 * The `/auth` command: a textual veneer over the {@link DshAuthApi} — status
 * listing, login (optionally picking the provider interactively), logout.
 *
 * @module @deepseek-harness-tui/dsh-tui/oauth/command
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { DshAuthApi, DshAuthSignInStatus } from './service.js'

const USAGE = 'Usage: /auth [status] | /auth login [provider] | /auth logout <provider>'

function renderStatus(rows: readonly DshAuthSignInStatus[]): string {
  const lines = rows.map(row => {
    const state = row.signedIn
      ? row.expiresAt === undefined
        ? 'signed in'
        : `signed in — token expires ${new Date(row.expiresAt).toISOString()}`
      : row.expired
        ? 'signed in, token expired — /auth login to refresh'
        : 'not signed in'
    return `  ${row.provider.padEnd(14)} ${state}`
  })
  return ['dsh-auth providers:', ...lines].join('\n')
}

/** Split the raw input into at most two lowercase words: verb and target. */
function parseArgs(raw: string): { verb: string | undefined; target: string | undefined } {
  const words = raw.trim().split(/\s+/u).filter(word => word !== '')
  const verb = words[0]?.toLowerCase()
  const target = words[1]
  return { verb: words.length === 0 ? undefined : verb, target }
}

/**
 * Build the `/auth` handler. Every failure returns a `CommandResult`, never a
 * rejection the host would have to translate; unexpected throws still
 * propagate for the host's own error surface.
 */
export function createAuthCommandHandler(api: DshAuthApi): (invocation: CommandInvocation) => Promise<CommandResult> {
  return async invocation => {
    const { verb, target } = parseArgs(invocation.rawInput)
    if (verb === undefined || verb === 'status') {
      if (target !== undefined) return { kind: 'error', text: USAGE }
      return { kind: 'success', text: renderStatus(await api.providers()) }
    }
    if (verb === 'login') {
      try {
        const result = await api.login(target, invocation.signal)
        return {
          kind: 'success',
          text: `Signed in to ${result.oauthLabel} (${result.provider})`
            + `${result.expiresAt === undefined ? '' : `; token expires ${new Date(result.expiresAt).toISOString()}`}. `
            + 'Its models are selectable via /model.',
        }
      } catch (error: unknown) {
        return { kind: 'error', text: `dsh-auth: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (verb === 'logout') {
      if (target === undefined) return { kind: 'error', text: USAGE }
      try {
        const removed = await api.logout(target)
        return removed
          ? { kind: 'success', text: `Signed out of ${target}; its stored credential was removed.` }
          : { kind: 'error', text: `${target} was not signed in.` }
      } catch (error: unknown) {
        return { kind: 'error', text: `dsh-auth: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    return { kind: 'error', text: USAGE }
  }
}
