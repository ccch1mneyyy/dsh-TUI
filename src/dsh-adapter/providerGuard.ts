/**
 * Question-provider seat guard (issue #98 security follow-up).
 *
 * The harness allows exactly ONE user-questions provider per context. The
 * original fix made this TUI yield the seat silently on DUPLICATE_PROVIDER so
 * profiles carrying @deepseek-ai/dsh-web-app keep booting — but silence cuts
 * both ways: a malicious plugin that registers FIRST also gets silent
 * ownership of the questionnaire and can answer the model's
 * ask_user_question on the user's behalf.
 *
 * The upstream error carries no incumbent identity (fixed message + code
 * only), and the public API offers no query — but the service stores the
 * incumbent provider object on its `provider` property, which is reachable
 * structurally. This module turns that probe into a whitelist decision:
 * known host front doors (dsh-web-app, this TUI itself) stay silent;
 * anything else — including "no identity available" — raises the alert path.
 */

/**
 * Front doors allowed to hold the questionnaire seat without a notice.
 * Third-party plugins must not be listed here: the seat decides who speaks
 * FOR the user to the model.
 */
export const QUESTION_PROVIDER_HOST_WHITELIST: readonly string[] = ['dsh-web-app', 'dsh-tui']

/** What apply() should do after a DUPLICATE_PROVIDER registration attempt. */
export interface QuestionProviderYieldDecision {
  /** `silent` keeps the issue-#98 behavior; `alert` notifies the user. */
  readonly action: 'silent' | 'alert'
  /** The incumbent identity the decision was based on, when one was found. */
  readonly incumbentId: string | undefined
}

/**
 * Decide how to react to an incumbent user-questions provider. Anything not
 * provably a known host front door alerts — the conservative default for an
 * unidentifiable incumbent, because silence is exactly what an attacker
 * squatting the seat wants.
 */
export function decideQuestionProviderYield(incumbentId: string | undefined): QuestionProviderYieldDecision {
  if (incumbentId !== undefined && QUESTION_PROVIDER_HOST_WHITELIST.includes(incumbentId)) {
    return { action: 'silent', incumbentId }
  }
  return { action: 'alert', incumbentId }
}

/**
 * Module-private tag marking a provider object as this TUI's own. Symbol-keyed
 * so a third party cannot forge the marker by copying visible fields onto its
 * provider (the symbol never leaves this module).
 */
const TUI_PROVIDER_TAG = Symbol('dsh-tui question provider')

/** Tag a provider this TUI is about to register so a later boot (recompose
 * leftover, restart race) can recognize itself in the seat. */
export function tagTuiQuestionProvider(provider: object): void {
  try {
    Object.defineProperty(provider, TUI_PROVIDER_TAG, {
      value: 'dsh-tui',
      configurable: false,
      writable: false,
      enumerable: false,
    })
  } catch {
    // A frozen provider from an older TUI copy simply stays untagged — the
    // decision then falls back to the conservative alert, never a crash.
  }
}

/**
 * Probe the user-questions service for the incumbent provider's identity.
 *
 * Recognition order:
 *   1. this TUI's private symbol tag (unforgeable outside the module);
 *   2. an explicit identity marker the incumbent attached (`name`, `hostId`,
 *      `id`) — honor host cooperation if upstream starts tagging providers;
 *   3. nothing — return undefined, which the decision maps to the alert path.
 */
export function incumbentQuestionProviderId(service: object): string | undefined {
  let provider: unknown
  try {
    provider = (service as { provider?: unknown }).provider
  } catch {
    return undefined
  }
  if (provider === null || typeof provider !== 'object') return undefined
  try {
    if ((provider as Record<symbol, unknown>)[TUI_PROVIDER_TAG] === 'dsh-tui') return 'dsh-tui'
    for (const key of ['name', 'hostId', 'id'] as const) {
      const value = (provider as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  } catch {
    // A getter that throws must not take the boot down with it.
  }
  return undefined
}
