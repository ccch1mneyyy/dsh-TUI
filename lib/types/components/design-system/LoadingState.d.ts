import React from 'react';
/**
 * A spinner with a loading message for async operations, ported from the
 * leak's design-system/LoadingState.tsx (using the small animated glyph).
 *
 * @example
 * <LoadingState message="Loading models" bold subtitle="Querying the provider…" />
 */
export declare function LoadingState({ message, bold, dimColor, subtitle, }: {
    /** The loading message to display next to the spinner. */
    message: string;
    /** Display the message in bold. @default false */
    bold?: boolean;
    /** Display the message in dimmed color. @default false */
    dimColor?: boolean;
    /** Optional subtitle displayed below the main message. */
    subtitle?: string;
}): React.ReactNode;
//# sourceMappingURL=LoadingState.d.ts.map