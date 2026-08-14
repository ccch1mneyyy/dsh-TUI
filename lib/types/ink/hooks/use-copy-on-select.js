import { useEffect, useRef } from 'react';
import { hasSelection } from '../selection.js';
import { useSelection } from './use-selection.js';
/**
 * Copy-on-select: when a drag finishes (or a double/triple click, or a
 * shift+arrow extension, lands a selection), copy the selected text to the
 * clipboard — OSC 52 plus the native-utility fallback — then clear the
 * highlight so the copy reads as a completed action.
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
 */
export function useCopyOnSelect(onCopied) {
    const { subscribe, getState, copySelection } = useSelection();
    const onCopiedRef = useRef(onCopied);
    onCopiedRef.current = onCopied;
    useEffect(() => {
        return subscribe(() => {
            const state = getState();
            // Mid-drag notifications (every motion event) skip the copy; the
            // release notification arrives with isDragging already cleared.
            if (state && !state.isDragging && hasSelection(state)) {
                const text = copySelection();
                if (text)
                    onCopiedRef.current?.(text);
            }
        });
    }, [subscribe, getState, copySelection]);
}
