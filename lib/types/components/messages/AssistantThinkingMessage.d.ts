import React from 'react';
type Props = {
    thinking: string;
    /** Adds the top margin between messages (CC: addMargin). */
    addMargin: boolean;
    /** True when Ctrl+O transcript/verbose mode is on — show the full text. */
    verbose: boolean;
    /** Thinking wall-clock duration once the reasoning block settled (ms). */
    durationMs?: number;
    /** Message-selection mode highlight. */
    isSelected?: boolean;
    onClick?(): void;
};
/**
 * Thinking block: folded `∴ Thinking (ctrl+o to expand)`, expanded shows the
 * full reasoning text indented under `∴ Thinking…` (ported from the leak's
 * `messages/AssistantThinkingMessage.tsx`). When the channel records the
 * reasoning duration, the label carries it (`∴ Thinking · 12s …`) — dsh-tui's
 * take on making thinking time visible in the transcript.
 */
export declare function AssistantThinkingMessage({ thinking, addMargin, verbose, durationMs, isSelected, onClick, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=AssistantThinkingMessage.d.ts.map