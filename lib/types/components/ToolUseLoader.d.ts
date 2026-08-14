import React from 'react';
type Props = {
    isError: boolean;
    isUnresolved: boolean;
    shouldAnimate: boolean;
};
/**
 * The status dot on tool-card headers (ported from the leak's
 * ToolUseLoader): blinking `●` while running, theme-blue on success, rose on
 * error, dim while queued.
 */
export declare function ToolUseLoader({ isError, isUnresolved, shouldAnimate, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=ToolUseLoader.d.ts.map