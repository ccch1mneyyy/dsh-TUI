/**
 * plan-aware-persona — keep liangshen's byte-identical Minimal persona in
 * normal mode and splice dsh-plan-mode's deployment-owned plan guidance into
 * that SAME complete persona section only while BOTH the TUI's `/planPrompt`
 * injection switch is on AND the session really is in plan mode (or a switch
 * to it is pending).
 *
 * WHY: the preset used a static `@deepseek-ai/dsh-persona` row with
 * `complete: true`, so the prompt assembly kept only the persona section and
 * dsh-plan-mode's `plan:policy` section could never reach the model. The TUI
 * `/planPrompt` command appends the durable `plan-prompt/mode` event AND the
 * real `plan/mode` activation; this plugin renders the sole complete section
 * only when both agree:
 *
 *   /planPrompt off (default): "You are a helpful software engineer assistant."
 *   /planPrompt on + plan mode: that base persona + "\n\n" + the YAML-configured
 *                              plan section (read live from
 *                              `ctx.planMode.section`, never copied here, so
 *                              the YAML remains the single source of truth).
 *
 * Gating on real plan state is load-bearing: `exit_plan_mode` only exists
 * while `plan/mode` is active. Injecting "You are in plan mode" without the
 * matching state made the model follow plan-mode rules but fail to exit, and
 * it could then wrongly infer implementation had started.
 *
 * The existing `/plan` command is unchanged. This plugin READS plan state
 * (through `planMode.get`, including pending exit/entry) but never writes
 * `plan/mode`; the TUI `/planPrompt` command owns its own mode transition.
 *
 * `complete: true` stays set, so the assembled system prompt still contains
 * exactly one section in every mode — the Minimal byte anchor is preserved
 * when the switch is off and no other section is added while it is on.
 */

/**
 * Pinned to the exported values of `@deepseek-ai/dsh-system-prompt` so this
 * file stays importable after `ensurePackagedPresets` copies it to
 * `~/.dsh/.agent-presets/liangshen/` — that directory is outside the package
 * `node_modules`, and local preset plugins must not carry bare imports. The
 * regression script asserts these two pins against the real package exports.
 */
export const PERSONA_SECTION = 'deployment:persona'
export const PERSONA_ORDER = 0

/** Durable session event the TUI appends for `/planPrompt` / `/planPrompt off`. */
export const PLAN_PROMPT_EVENT = 'plan-prompt/mode'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plan-aware-persona'

/**
 * `planMode` must resolve to the same isolate realm the sibling
 * `@deepseek-ai/dsh-plan-mode` row was mounted in, which is why this plugin
 * lives inside the `planning` group in agent.cordis.yml. The configured
 * `section` and the per-agent state (`get`) are read here; `set` is never
 * called, so this plugin cannot change `/plan` behavior.
 */
export const inject = ['planMode', 'systemPrompt']

/** Byte-identical to the previous static persona row (Minimal preset text). */
const BASE_PERSONA = 'You are a helpful software engineer assistant.'

/**
 * Last `plan-prompt/mode` event wins; no event means off (the previous
 * liangshen behavior). A missing or malformed payload is treated as off.
 */
export function foldPlanPrompt(events) {
  let active = false
  for (const event of events ?? []) {
    if (event?.type !== PLAN_PROMPT_EVENT) continue
    active = event.data?.active === true
  }
  return active
}

/**
 * Register the sole complete persona section, switching its text by the
 * durable `/planPrompt` switch. Runtime context stays suppressed exactly like
 * the previous `includeRuntimeContext: false` persona row.
 */
export function apply(ctx) {
  ctx.systemPrompt.suppressRuntimeContext()

  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    complete: true,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return BASE_PERSONA

      if (!foldPlanPrompt(agent.session?.events)) return BASE_PERSONA

      // The prompt claims plan mode, so the real state must agree.
      // Pending wins over the logged state, mirroring dsh-plan-mode's own
      // section semantics: an approved exit (pending: false) drops the plan
      // guidance immediately, before the next step appends `plan/mode`.
      const state = ctx.planMode.get(agent)
      const planning = state.pending ?? state.active
      if (planning !== true) return BASE_PERSONA

      const section = typeof ctx.planMode.section === 'string' ? ctx.planMode.section : ''
      return section.trim() === '' ? BASE_PERSONA : `${BASE_PERSONA}\n\n${section}`
    },
  }), 'plan-aware-persona: complete persona')
}
