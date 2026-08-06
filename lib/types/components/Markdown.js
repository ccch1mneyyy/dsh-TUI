import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import { marked } from 'marked';
import { Box, Text } from '../ui.js';
import { configureMarked, formatToken, stripPromptXMLTags } from '../cc/markdown.js';
import { getCliHighlightPromise } from '../cc/cliHighlight.js';
import { hashContent } from '../cc/hash.js';
import { MarkdownTable } from './MarkdownTable.js';
// Module-level token cache — marked.lexer is the hot cost on remounts.
// Messages are immutable; same content → same tokens.
const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map();
// Characters that indicate markdown syntax. If none are present, skip the
// ~3ms marked.lexer call entirely — render as a single paragraph.
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s) {
    return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}
function cachedLexer(content) {
    // Fast path: plain text with no markdown syntax → single paragraph token.
    if (!hasMarkdownSyntax(content)) {
        return [
            {
                type: 'paragraph',
                raw: content,
                text: content,
                tokens: [{ type: 'text', raw: content, text: content }],
            },
        ];
    }
    const key = hashContent(content);
    const hit = tokenCache.get(key);
    if (hit) {
        // Promote to MRU
        tokenCache.delete(key);
        tokenCache.set(key, hit);
        return hit;
    }
    const tokens = marked.lexer(content);
    if (tokenCache.size >= TOKEN_CACHE_MAX) {
        const first = tokenCache.keys().next().value;
        if (first !== undefined)
            tokenCache.delete(first);
    }
    tokenCache.set(key, tokens);
    return tokens;
}
/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as bordered flexbox components
 * - Other content is rendered as ANSI strings via formatToken
 */
export function Markdown({ children, dimColor = false }) {
    const [highlight, setHighlight] = React.useState(null);
    React.useEffect(() => {
        let alive = true;
        void getCliHighlightPromise().then(loaded => {
            if (alive)
                setHighlight(loaded);
        });
        return () => {
            alive = false;
        };
    }, []);
    configureMarked();
    const elements = React.useMemo(() => {
        const tokens = cachedLexer(stripPromptXMLTags(children));
        const elements = [];
        let nonTableContent = '';
        function flushNonTableContent() {
            if (nonTableContent) {
                elements.push(_jsx(Text, { dimColor: dimColor, children: nonTableContent.trim() }, elements.length));
                nonTableContent = '';
            }
        }
        for (const token of tokens) {
            if (token.type === 'table') {
                flushNonTableContent();
                elements.push(_jsx(MarkdownTable, { token: token, highlight: highlight }, elements.length));
            }
            else {
                nonTableContent += formatToken(token, 0, null, null, highlight);
            }
        }
        flushNonTableContent();
        return elements;
    }, [children, dimColor, highlight]);
    return (_jsx(Box, { flexDirection: "column", gap: 1, children: elements }));
}
//# sourceMappingURL=Markdown.js.map