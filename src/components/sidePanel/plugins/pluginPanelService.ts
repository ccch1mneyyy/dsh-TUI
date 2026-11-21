/**
 * Runtime probe for the optional profile plugin service.
 *
 * `ChannelUi` declares both capabilities, but partial channel fixtures and
 * older embedders can omit them. `pluginPanelAvailable()` is authoritative
 * when present; without it, the data method is the only usable capability —
 * its absence must read as "service unavailable" instead of being called and
 * tripping PanelErrorBoundary.
 */
export interface PluginPanelServiceChannel {
  readonly pluginPanelAvailable?: () => boolean
  readonly pluginPanelBundles?: () => Promise<unknown>
}

export function pluginPanelServiceAvailable(channel: PluginPanelServiceChannel): boolean {
  if (typeof channel.pluginPanelAvailable === 'function') return channel.pluginPanelAvailable()
  return typeof channel.pluginPanelBundles === 'function'
}
