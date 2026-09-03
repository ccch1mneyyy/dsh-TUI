/**
 * Shared Channel Host-Port effect-capability map and derived feature list.
 *
 * This is the single source that `HostFacade` shadow policy, the Channel
 * upstream driver and the Kernel channel slice all consume. Keeping it here
 * prevents the slice declaration / driver feature list from drifting from the
 * methods actually exposed by `HostChannelPort`.
 */

export const CHANNEL_PORT_METHOD_CAPABILITIES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  projection: Object.freeze({
    snapshot: 'host.channel.projection.snapshot',
    subscribe: 'host.channel.projection.subscribe',
  }),
  actions: Object.freeze({
    submit: 'host.channel.actions.submit',
    steer: 'host.channel.actions.steer',
    cancel: 'host.channel.actions.cancel',
    interruptAndDeliver: 'host.channel.actions.interruptAndDeliver',
    clear: 'host.channel.actions.clear',
    loadOlder: 'host.channel.actions.loadOlder',
    notify: 'host.channel.actions.notify',
  }),
  state: Object.freeze({
    snapshot: 'host.channel.state.snapshot',
  }),
  plugins: Object.freeze({
    runExternalCommand: 'host.channel.plugins.run-external-command',
    openPluginScene: 'host.channel.plugins.open-scene',
    closePluginScene: 'host.channel.plugins.close-scene',
    settingsSections: 'host.channel.plugins.settings-sections',
    subscribeSettingsSections: 'host.channel.plugins.subscribe-settings-sections',
  }),
  transcript: Object.freeze({
    rows: 'host.channel.transcript.rows',
    traceEvents: 'host.channel.transcript.trace-events',
  }),
})

export const CHANNEL_FEATURES: readonly string[] = Object.freeze(
  [...new Set(
    Object.values(CHANNEL_PORT_METHOD_CAPABILITIES)
      .flatMap(subPort => Object.values(subPort)),
  )],
)

export const CHANNEL_STANDARD_DECLARATIONS: readonly string[] = CHANNEL_FEATURES
