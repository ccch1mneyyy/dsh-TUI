import type { ComposerImageRef, PendingMessage } from './types.js'

/** Small mutable cells for Channel-local warning and pending-message state. */
export function createContextBookkeeping(
  state: () => {
    contextWindow: number | undefined
    tokens: { input: number }
    pending: PendingMessage[]
    emit(): void
  },
  notify: (text: string, options: { color: 'warning'; timeoutMs: number }) => unknown,
  lowContextText: (percent: number) => string,
  warningBufferTokens: number,
) {
  const warning = { value: false }
  const checkContextWarning = (): void => {
    const channel = state()
    if (warning.value || channel.contextWindow === undefined) return
    const remaining = channel.contextWindow - channel.tokens.input
    if (remaining >= warningBufferTokens) return
    warning.value = true
    notify(lowContextText(Math.max(0, Math.round((remaining / channel.contextWindow) * 100))), {
      color: 'warning', timeoutMs: 8000,
    })
  }
  const trackPending = (message: { id: string; text: string; images?: readonly ComposerImageRef[] }, placement: PendingMessage['placement']): void => {
    const channel = state()
    channel.pending = [...channel.pending, { id: message.id, text: message.text, images: message.images ?? [], placement }]
    channel.emit()
  }
  const untrackPending = (messageId: string): void => {
    const channel = state()
    const before = channel.pending.length
    channel.pending = channel.pending.filter(item => item.id !== messageId)
    if (channel.pending.length !== before) channel.emit()
  }
  const resetContextWarning = (): void => { warning.value = false }
  return { warning, resetContextWarning, checkContextWarning, trackPending, untrackPending }
}
