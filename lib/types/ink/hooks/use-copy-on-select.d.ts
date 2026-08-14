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
export declare function useCopyOnSelect(onCopied?: (text: string) => void): void;
//# sourceMappingURL=use-copy-on-select.d.ts.map