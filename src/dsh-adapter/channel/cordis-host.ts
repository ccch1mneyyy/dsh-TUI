/**
 * The ChannelHost a Cordis plugin context provides. Root-keyed registries
 * (adapter runtime, decision gate and handlers, local settings sections) stay
 * keyed on the Cordis root, so the extensions row that also installs the gate
 * meets the channel on one registry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { adapterRuntimeFor } from '../../adapter/kernel/runtime-context.js'
import { installDecisionGuard, markDecisionDispatchTopology } from '../decision-guard.js'
import { dispatchTuiDecision, dispatchTuiNotification } from '../extension-events.js'
import { getLocalSettingsSectionsHost } from '../settings-sections.js'
import type { ChannelHost } from './channel-host.js'

/**
 * @param services - Services served in place of the context's own (the
 *   TUI's file-backed `settings`, ../tui-settings.ts).
 */
export function cordisChannelHost(ctx: Context, services: Readonly<Record<string, unknown>> = {}): ChannelHost {
  const withEffect = ctx as Context & {
    effect?: (setup: () => () => void, label?: string) => void
  }
  return {
    get: name => Object.hasOwn(services, name) ? services[name] : ctx.get(name as never),
    // Read per use.
    get logger() { return ctx.logger },
    runtime: adapterRuntimeFor(ctx),
    // Bare embedders (scripts) mount without the effect capability.
    ...(withEffect.effect === undefined ? {} : {
      effect: (setup, label) => { withEffect.effect?.call(ctx, setup, label) },
    }),
    onAgentPreStep: listener => ctx.on('agent/pre-step', listener as never),
    dispatchDecision: (name, payload, normalize) => dispatchTuiDecision(ctx, name, payload, normalize),
    dispatchNotification: (name, payload) => dispatchTuiNotification(ctx, name, payload),
    installDecisionGuard: grants => { installDecisionGuard(ctx, grants) },
    markDecisionDispatchTopology: () => markDecisionDispatchTopology(ctx),
    localSettingsSections: () => getLocalSettingsSectionsHost(ctx),
    // Cordis announces every service change on the root; bare embedders
    // (scripts) without `on` hear nothing.
    ...(typeof (ctx as { on?: unknown }).on !== 'function' ? {} : {
      watchServices: listener => ctx.on('internal/service' as never, ((name: unknown) => {
        if (typeof name === 'string') listener(name)
      }) as never),
    }),
  }
}
