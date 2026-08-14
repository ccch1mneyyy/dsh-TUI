import React from 'react';
type Props = {
    isError: boolean;
    isUnresolved: boolean;
    shouldAnimate: boolean;
};
/**
 * The status dot on tool-call rows (ported from the leak's ToolUseLoader):
 * blinking `●` while running, green on success, red on error, dim when queued.
 */
export declare function ToolUseLoader({ isError, isUnresolved, shouldAnimate, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=ToolUseLoader.d.ts.map