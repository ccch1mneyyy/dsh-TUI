import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { marked } from 'marked';
import Box from '../ink/components/Box.js';
import { stripPromptXMLTags } from '../cc/markdown.js';
import { Markdown } from './Markdown.js';
/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta (ported from the leak's
 * `StreamingMarkdown.tsx`). marked.lexer() correctly handles unclosed code
 * fences as a single token, so block boundaries are always safe.
 */
export function StreamingMarkdown({ children, }) {
    const stablePrefixRef = React.useRef('');
    const stripped = stripPromptXMLTags(children);
    // Reset if text was replaced (defensive; normally unmount handles this)
    if (!stripped.startsWith(stablePrefixRef.current)) {
        stablePrefixRef.current = '';
    }
    // Lex only from current boundary — O(unstable length), not O(full text)
    const boundary = stablePrefixRef.current.length;
    const tokens = marked.lexer(stripped.substring(boundary));
    // Last non-space token is the growing block; everything before is final
    let lastContentIdx = tokens.length - 1;
    while (lastContentIdx >= 0 && tokens[lastContentIdx].type === 'space') {
        lastContentIdx--;
    }
    let advance = 0;
    for (let i = 0; i < lastContentIdx; i++) {
        advance += tokens[i].raw.length;
    }
    if (advance > 0) {
        stablePrefixRef.current = stripped.substring(0, boundary + advance);
    }
    const stablePrefix = stablePrefixRef.current;
    const unstableSuffix = stripped.substring(stablePrefix.length);
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [stablePrefix && _jsx(Markdown, { children: stablePrefix }), unstableSuffix && _jsx(Markdown, { cacheTokens: false, children: unstableSuffix })] }));
}
