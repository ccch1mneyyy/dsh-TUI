import { useEffect, useRef } from 'react'
import { hasSelection } from '../selection.js'
import { useSelection } from './use-selection.js'

/**
 * Copy-on-select: when a drag finishes (or a double/triple click, or a
 * shift+arrow extension, lands a selection), copy the selected text to the
 * clipboard — OSC 52 plus the native-utility fallback — keeping the
 * highlight until the user clears or replaces the selection.
 *
 * Implemented as a subscription rather than a mouse-release hook so every
 * path that settles a selection (release, lost-release recovery, focus-out
 * recovery, multi-click, keyboard extension) funnels through the same
 * `notifySelectionChange` and fires the copy exactly once per settle.
 *
 * No-op outside fullscreen: without mouse tracking no selection can ever
 * exist, and `useSelection` returns stubs when there is no Ink instance.
 * Mount once near the app root (e.g. Chat) — the copy itself is gated on
 * `hasSelection`, so an always-mounted hook costs one no-op callback per
 * selection notification.
 * @param onCopied - called with the copied text after each successful copy
 *   (e.g. to show a toast). Stored in a ref, so an inline closure is fine
 *   and never re-subscribes.
 * @param onRefused - called when the selection was marked stale (its rows
 *   were replaced in place while highlighted): the highlight is cleared
 *   and NOTHING is copied — the caller should tell the user why (e.g.
 *   "content changed, copy cancelled") instead of staying silent.
 */
export function useCopyOnSelect(
  onCopied?: (text: string) => void,
  onRefused?: () => void,
): void {
  const { subscribe, getState, copySelectionNoClear } = useSelection()
  const onCopiedRef = useRef(onCopied)
  onCopiedRef.current = onCopied
  const onRefusedRef = useRef(onRefused)
  onRefusedRef.current = onRefused
  useEffect(() => {
    let copiedRevision = -1
    return subscribe(() => {
      const state = getState()
      // Mid-drag notifications (every motion event) skip the copy; the
      // release notification arrives with isDragging already cleared.
      if (state && !state.isDragging && hasSelection(state)) {
        // Retained selections can receive repeated release notifications.
        // Copy once per completion, including a new gesture on the same text.
        if (copiedRevision === state.settledRevision) return
        copiedRevision = state.settledRevision
        if (state.stale) {
          // copySelectionNoClear clears the stale highlight; its internal copy
          // is refused (empty), so the only user-visible effect without
          // this branch would be a highlight vanishing for no reason.
          copySelectionNoClear()
          onRefusedRef.current?.()
          return
        }
        const text = copySelectionNoClear()
        if (text) onCopiedRef.current?.(text)
      }
    })
  }, [subscribe, getState, copySelectionNoClear])
}
