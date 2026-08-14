import React from 'react';
type Props = {
    text: string;
    /** Adds the top margin between messages (CC: addMargin). */
    addMargin: boolean;
    /** Message-selection mode highlight. */
    isSelected?: boolean;
    /** Row expanded on its own (persistent hover-grey background, CC). */
    isExpanded?: boolean;
    onClick?(): void;
};
/**
 * Assistant text message:  bullet + markdown body (ported from the
 * leak's  default branch).
 */
export declare function AssistantTextMessage({ text, addMargin, isSelected, isExpanded, onClick, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=AssistantTextMessage.d.ts.map