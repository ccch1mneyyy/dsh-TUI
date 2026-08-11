import React from 'react';
/**
 * Component that parses ANSI escape codes and renders them using Text components.
 *
 * Use this as an escape hatch when you have pre-formatted ANSI strings from
 * external tools (like cli-highlight) that need to be rendered in Ink.
 *
 * Memoized to prevent re-renders when parent changes but children string is the same.
 */
export declare const Ansi: React.MemoExoticComponent<(t0: any) => any>;
//# sourceMappingURL=Ansi.d.ts.map