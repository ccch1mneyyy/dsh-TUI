import { useEffect } from 'react';
import { hasSelection } from '../selection.js';
import { useSelection } from './use-selection.js';
/**
 * iTerm2-style copy-on-select: when a drag finishes (or a double/triple
 * click, or a shift+arrow extension, lands a selection), copy the selected
 * text to the clipboard — OSC 52 plus the native-utility fallback — while
 * keeping the highlight visible.
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
 */
export function useCopyOnSelect() {
    const { subscribe, getState, copySelectionNoClear } = useSelection();
    useEffect(() => {
        return subscribe(() => {
            const state = getState();
            // Mid-drag notifications (every motion event) skip the copy; the
            // release notification arrives with isDragging already cleared.
            if (state && !state.isDragging && hasSelection(state)) {
                copySelectionNoClear();
            }
        });
    }, [subscribe, getState, copySelectionNoClear]);
}
