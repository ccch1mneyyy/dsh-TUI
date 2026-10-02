import type { ContextOccupancy } from '../../adapter/ports/channel-view.js'
import type { ComposerImageRef, PendingMessage } from './types.js'

/** Small mutable cells for Channel-local warning and pending-message state. */
export function createContextBookkeeping(
  state: () => {
    /** The channel's single occupancy reading (projection first, sample
     *  fallback) — the honest numerator for the context-low warning. */
    contextOccupancy: ContextOccupancy | undefined
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
    const occupancy = channel.contextOccupancy
    // No window (no route capacity) is the only reason to stay silent: the
    // numerator is now the projected occupancy, which exists as soon as a
    // meter (any normal deployment) or one settled request knows anything.
    if (warning.value || occupancy === undefined || occupancy.contextWindow === undefined) return
    if (occupancy.contextWindow <= 0) return
    const remaining = occupancy.contextWindow - occupancy.usedTokens
    if (remaining >= warningBufferTokens) return
    warning.value = true
    notify(lowContextText(Math.max(0, Math.round((remaining / occupancy.contextWindow) * 100))), {
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
