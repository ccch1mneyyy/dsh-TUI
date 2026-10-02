export const TUI_CHANNEL_HTTP_API_VERSION: 'tui.dsh/v1alpha1'
export const TUI_CHANNEL_HTTP_KIND: 'ChannelEndpoint'
export const TUI_CHANNEL_HTTP_HEALTH_PATH: '/dsh-tui/v1/health'
export const TUI_CHANNEL_HTTP_DESCRIPTOR_PATH: '/dsh-tui/v1/endpoint'
export const TUI_CHANNEL_HTTP_WEBSOCKET_PATH: '/dsh-tui/v1/connection'

export interface TuiChannelEndpointDescriptor {
  readonly apiVersion: typeof TUI_CHANNEL_HTTP_API_VERSION
  readonly kind: typeof TUI_CHANNEL_HTTP_KIND
  readonly origin: string
  readonly connection: typeof TUI_CHANNEL_HTTP_WEBSOCKET_PATH
}

export function createTuiChannelEndpointDescriptor(origin: string): TuiChannelEndpointDescriptor
export function validateTuiChannelEndpointDescriptor(value: unknown): TuiChannelEndpointDescriptor
