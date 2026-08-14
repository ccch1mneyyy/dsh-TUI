import React from 'react';
/**
 * A single-line search input in the round-bordered box of the leak's
 * SearchBox: `⌕ ` prefix, block cursor at `cursorOffset` (inverse cell).
 * When empty and focused, a solid block caret sits at the start and the
 * placeholder is right-aligned (dimmed) — kept off the caret's cell so the
 * terminal-painted IME preedit (pinyin) can never be overlaid on it during
 * CJK composition.
 */
export declare function SearchBox({ query, placeholder, isFocused, isTerminalFocused, prefix, width, cursorOffset, borderless, }: {
    query: string;
    placeholder?: string;
    isFocused: boolean;
    isTerminalFocused: boolean;
    prefix?: string;
    width?: number | string;
    cursorOffset?: number;
    borderless?: boolean;
}): React.ReactNode;
//# sourceMappingURL=SearchBox.d.ts.map