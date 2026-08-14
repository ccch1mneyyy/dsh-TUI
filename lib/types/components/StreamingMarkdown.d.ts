import React from 'react';
/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta (ported from the leak's
 * `StreamingMarkdown.tsx`). marked.lexer() correctly handles unclosed code
 * fences as a single token, so block boundaries are always safe.
 */
export declare function StreamingMarkdown({ children, }: {
    children: string;
}): React.ReactNode;
//# sourceMappingURL=StreamingMarkdown.d.ts.map