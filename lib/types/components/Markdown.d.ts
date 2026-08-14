import React from 'react';
/**
 * Markdown renderer ported from Claude Code (the leak's `Markdown.tsx`):
 * marked lexer + ANSI formatter, tables rendered as flexbox-style bordered
 * components, async syntax highlighting via cli-highlight. The ANSI strings
 * render inside raw `Text` (the ported Ink core preserves ANSI in children;
 * the fork's `Ansi` span parser drops SGR 1 bold).
 */
type Props = {
    children: string;
    /** When true, render all text content as dim */
    dimColor?: boolean;
    /** False for the streaming tail (its content changes every chunk, so a
     *  cache entry would never hit and would only pollute the token cache). */
    cacheTokens?: boolean;
};
/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as bordered flexbox components
 * - Other content is rendered as ANSI strings via formatToken
 */
export declare function Markdown({ children, dimColor, cacheTokens }: Props): React.ReactNode;
export {};
//# sourceMappingURL=Markdown.d.ts.map