import React from 'react';
type Props = {
    text: string;
    /** Adds the top margin between turns (CC: addMargin). */
    addMargin: boolean;
    /** Message-selection mode highlight. */
    isSelected?: boolean;
    /** Row expanded on its own (persistent hover-grey background, CC). */
    isExpanded?: boolean;
    onClick?(): void;
};
/**
 * User prompt bubble: `❯ text` on the theme's userMessageBackground grey
 * (ported from the leak's `messages/UserPromptMessage.tsx` +
 * `HighlightedThinkingText.tsx`, with the ultrathink rainbow removed).
 */
export declare function UserPromptMessage({ text, addMargin, isSelected, isExpanded, onClick, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=UserPromptMessage.d.ts.map