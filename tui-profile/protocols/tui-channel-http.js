export const TUI_CHANNEL_HTTP_API_VERSION = 'tui.dsh/v1alpha1'
export const TUI_CHANNEL_HTTP_KIND = 'ChannelEndpoint'
export const TUI_CHANNEL_HTTP_HEALTH_PATH = '/dsh-tui/v1/health'
export const TUI_CHANNEL_HTTP_DESCRIPTOR_PATH = '/dsh-tui/v1/endpoint'
export const TUI_CHANNEL_HTTP_WEBSOCKET_PATH = '/dsh-tui/v1/connection'

export function createTuiChannelEndpointDescriptor(origin) {
  const normalized = new URL(origin)
  if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
    throw new TypeError('TUI Channel endpoint origin must use http or https')
  }
  normalized.pathname = '/'
  normalized.search = ''
  normalized.hash = ''
  return Object.freeze({
    apiVersion: TUI_CHANNEL_HTTP_API_VERSION,
    kind: TUI_CHANNEL_HTTP_KIND,
    origin: normalized.toString().replace(/\/$/u, ''),
    connection: TUI_CHANNEL_HTTP_WEBSOCKET_PATH,
  })
}

export function validateTuiChannelEndpointDescriptor(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('TUI Channel endpoint descriptor must be an object')
  if (value.apiVersion !== TUI_CHANNEL_HTTP_API_VERSION || value.kind !== TUI_CHANNEL_HTTP_KIND) {
    throw new TypeError('TUI Channel endpoint descriptor version or kind is unsupported')
  }
  if (typeof value.origin !== 'string') throw new TypeError('TUI Channel endpoint origin must be a string')
  createTuiChannelEndpointDescriptor(value.origin)
  if (value.connection !== TUI_CHANNEL_HTTP_WEBSOCKET_PATH) throw new TypeError('TUI Channel endpoint connection path is unsupported')
  return value
}
