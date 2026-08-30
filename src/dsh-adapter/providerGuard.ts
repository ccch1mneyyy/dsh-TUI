/**
 * Question-provider seat guard (issue #98 security follow-up).
 *
 * On the legacy/rc `registerProvider` API, the harness allows exactly ONE
 * user-questions provider per context. The original fix made this TUI yield
 * the seat silently on DUPLICATE_PROVIDER so profiles carrying
 * @deepseek-ai/dsh-web-app keep booting — but silence cuts both ways: a
 * malicious plugin that registers FIRST also gets silent ownership of the
 * questionnaire and can answer the model's ask_user_question on the user's
 * behalf.
 *
 * The upstream error carries no incumbent identity (fixed message + code
 * only), and the public API offers no query — but the service stores the
 * incumbent provider object on its `provider` property, which is reachable
 * structurally. This module turns that probe into a whitelist decision with
 * PROVENANCE: silent yields are reserved for host-verified identities (this
 * module's private symbol tag — the true host-coexistence scenario), while a
 * whitelist hit that the incumbent merely self-reported (name/hostId/id
 * fields any plugin can copy) gets an honest "identity not host-verified"
 * alert: forgeable silence is worse than a loud warning.
 */

/**
 * Front doors allowed to hold the questionnaire seat without a notice.
 * Third-party plugins must not be listed here: the seat decides who speaks
 * FOR the user to the model.
 */
export const QUESTION_PROVIDER_HOST_WHITELIST: readonly string[] = ['dsh-web-app', 'dsh-tui']

/**
 * The incumbent provider's identity as probed off the service, plus whether
 * that identity is host-verified. `verified: true` can only be minted by
 * this module's private symbol tag; self-reported `name`/`hostId`/`id`
 * fields are readable but forgeable by any plugin.
 */
export interface IncumbentQuestionProviderIdentity {
  readonly id: string
  readonly verified: boolean
}

/** What apply() should do after a DUPLICATE_PROVIDER registration attempt. */
export interface QuestionProviderYieldDecision {
  /**
   * `silent` keeps the issue-#98 behavior (host-verified whitelist only);
   * `alert` notifies the user; `alert-unverified` is the honest variant for
   * a self-reported whitelist hit — the name matches a host front door but
   * nothing proves who wrote it.
   */
  readonly action: 'silent' | 'alert' | 'alert-unverified'
  /** The incumbent identity the decision was based on, when one was found. */
  readonly incumbentId: string | undefined
}

/**
 * Decide how to react to an incumbent user-questions provider. Only a
 * HOST-VERIFIED whitelisted incumbent (the symbol tag) keeps the silent
 * yield: a self-reported `name: 'dsh-web-app'` is exactly what a seat
 * squatter would write, so whitelist hits without verification get the
 * unverified alert instead of silence. Third-party ids and no identity at
 * all alert — the conservative default, because silence is exactly what an
 * attacker squatting the seat wants.
 */
export function decideQuestionProviderYield(
  incumbent: IncumbentQuestionProviderIdentity | undefined,
): QuestionProviderYieldDecision {
  if (incumbent === undefined) return { action: 'alert', incumbentId: undefined }
  const whitelisted = QUESTION_PROVIDER_HOST_WHITELIST.includes(incumbent.id)
  if (incumbent.verified && whitelisted) return { action: 'silent', incumbentId: incumbent.id }
  if (whitelisted) return { action: 'alert-unverified', incumbentId: incumbent.id }
  return { action: 'alert', incumbentId: incumbent.id }
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
 *   1. this TUI's private symbol tag (unforgeable outside the module) —
 *      reported as verified;
 *   2. an explicit identity marker the incumbent attached (`name`, `hostId`,
 *      `id`) — readable for the notice text but reported as unverified,
 *      because those fields are trivially copyable by a squatter;
 *   3. nothing — return undefined, which the decision maps to the alert path.
 */
export function incumbentQuestionProviderId(service: object): IncumbentQuestionProviderIdentity | undefined {
  let provider: unknown
  try {
    provider = (service as { provider?: unknown }).provider
  } catch {
    return undefined
  }
  if (provider === null || typeof provider !== 'object') return undefined
  try {
    if ((provider as Record<symbol, unknown>)[TUI_PROVIDER_TAG] === 'dsh-tui') {
      return { id: 'dsh-tui', verified: true }
    }
    for (const key of ['name', 'hostId', 'id'] as const) {
      const value = (provider as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() !== '') return { id: value.trim(), verified: false }
    }
  } catch {
    // A getter that throws must not take the boot down with it.
  }
  return undefined
}
