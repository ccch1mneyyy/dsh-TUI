import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import { marked } from 'marked';
import { Box, Text } from '../ui.js';
import { configureMarked, formatToken, stripPromptXMLTags } from '../cc/markdown.js';
import { getCliHighlightPromise } from '../cc/cliHighlight.js';
import { MarkdownTable } from './MarkdownTable.js';
// Module-level token cache — marked.lexer is the hot cost on remounts.
// Messages are immutable; same content → same tokens.
//
// Bounds: entry count alone was not enough. Token.raw/text values are
// slices of the lexed input, so each entry pins its entire input string;
// during streaming the input grows every frame, and the LRU kept 500
// near-final snapshots ≈ 500 × message size resident (~500MB for a 1MB
// message). A character budget caps retained bytes; oversized contents
// skip the cache entirely (they are re-lexed on remount — rare, and
// cheaper than the retention).
const TOKEN_CACHE_MAX = 200;
const TOKEN_CACHE_MAX_CHARS = 200_000;
const TOKEN_CACHE_MAX_CONTENT = 20_000;
const tokenCache = new Map();
let tokenCacheChars = 0;
// Characters that indicate markdown syntax. If none are present, skip the
// ~3ms marked.lexer call entirely — render as a single paragraph.
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s) {
    return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}
function cachedLexer(content, cache) {
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
    if (!cache)
        return marked.lexer(content);
    // The content string itself is the key: V8 caches the string hash in the
    // string header, so Map lookup is hash-free after the first insert, and
    // unlike sha256 there is no per-call digest allocation or collision risk.
    const hit = tokenCache.get(content);
    if (hit) {
        // Promote to MRU
        tokenCache.delete(content);
        tokenCache.set(content, hit);
        return hit;
    }
    const tokens = marked.lexer(content);
    if (content.length > TOKEN_CACHE_MAX_CONTENT)
        return tokens;
    if (tokenCache.size >= TOKEN_CACHE_MAX ||
        tokenCacheChars + content.length > TOKEN_CACHE_MAX_CHARS) {
        tokenCache.clear();
        tokenCacheChars = 0;
    }
    tokenCache.set(content, tokens);
    tokenCacheChars += content.length;
    return tokens;
}
/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as bordered flexbox components
 * - Other content is rendered as ANSI strings via formatToken
 */
export function Markdown({ children, dimColor = false, cacheTokens = true }) {
    const [highlight, setHighlight] = React.useState(null);
    React.useEffect(() => {
        let alive = true;
        void getCliHighlightPromise().then((loaded) => {
            if (alive)
                setHighlight(loaded);
        });
        return () => {
            alive = false;
        };
    }, []);
    configureMarked();
    const elements = React.useMemo(() => {
        const tokens = cachedLexer(stripPromptXMLTags(children), cacheTokens);
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
    }, [children, dimColor, highlight, cacheTokens]);
    return (_jsx(Box, { flexDirection: "column", gap: 1, children: elements }));
}
