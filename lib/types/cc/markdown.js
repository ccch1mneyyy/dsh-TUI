/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment,
   typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return,
   typescript/restrict-plus-operands, typescript/no-unnecessary-condition,
   typescript/no-non-null-assertion, typescript/no-unnecessary-type-assertion,
   sonarjs/no-duplicated-branches
   -- ported Claude Code renderer (upstream src/utils/markdown.ts); historical lint debt kept with upstream idioms, like vendor/ */
import chalk from 'chalk';
import { marked } from 'marked';
import stripAnsi from 'strip-ansi';
import { stringWidth } from '../ink/stringWidth.js';
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js';
import { colorize } from '../ink/colorize.js';
import { getActiveTheme } from '../theme.js';
import { logForDebugging } from '../utils/debug.js';
import { createHyperlink } from './hyperlink.js';
// Ported from the leaked Claude Code source (src/utils/markdown.ts), with the
// app-level theme/color plumbing replaced by fixed ANSI styling and
// stripPromptXMLTags inlined. Renders marked tokens to ANSI strings.
const BLOCKQUOTE_BAR = '\u258e'; // ▎ - left one-quarter block
const STRIPPED_TAGS_RE = /<(commit_analysis|context|function_analysis|pr_analysis)>.*?<\/\1>\n?/gs;
/** Inline code color: the active theme's permission accent (Gentle Mist Blue). */
const permissionColor = (text) => colorize(text, getActiveTheme().permission, 'foreground');
/**
 * Strip tool-analysis XML tags (`<commit_analysis>`, `<context>`, `<function_analysis>`,
 * `<pr_analysis>`) and their contents, then trim the result.
 * @param content - Markdown text that may contain the wrapped tool-analysis tag blocks.
 * @returns The content with those blocks removed and surrounding whitespace trimmed.
 */
export function stripPromptXMLTags(content) {
    return content.replace(STRIPPED_TAGS_RE, '').trim();
}
// Use \n unconditionally — os.EOL is \r\n on Windows, and the extra \r
// breaks the character-to-segment mapping in applyStylesToWrappedText,
// causing styled text to shift right.
const EOL = '\n';
let markedConfigured = false;
/**
 * Configure the shared `marked` instance once: disable strikethrough parsing so
 * `~100` renders literally instead of as deleted text.
 */
export function configureMarked() {
    if (markedConfigured)
        return;
    markedConfigured = true;
    // Disable strikethrough parsing - the model often uses ~ for "approximate"
    // (e.g., ~100) and rarely intends actual strikethrough formatting
    marked.use({
        tokenizer: {
            del() {
                return undefined;
            },
        },
    });
}
/**
 * Render markdown content to ANSI-styled text via the shared `marked` instance.
 * @param content - Markdown source to render.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string, trimmed.
 */
export function applyMarkdown(content, highlight = null) {
    configureMarked();
    return marked
        .lexer(stripPromptXMLTags(content))
        .map(_ => formatToken(_, 0, null, null, highlight))
        .join('')
        .trim();
}
/**
 * Render one marked token to ANSI text, recursing into child tokens.
 * @param token - The marked token to render.
 * @param listDepth - Nesting depth of the enclosing list; drives indentation and numbering style.
 * @param orderedListNumber - Current ordinal of the enclosing ordered list item, or null for unordered lists.
 * @param parent - The parent token; linkification is skipped inside links and prefixes are added inside list items.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string for the token, or '' for unrendered token types.
 */
export function formatToken(token, listDepth = 0, orderedListNumber = null, parent = null, highlight = null) {
    switch (token.type) {
        case 'blockquote': {
            const inner = (token.tokens ?? [])
                .map(_ => formatToken(_, 0, null, null, highlight))
                .join('');
            // Prefix each line with a dim vertical bar. Keep text italic but at
            // normal brightness — chalk.dim is nearly invisible on dark themes.
            const bar = chalk.dim(BLOCKQUOTE_BAR);
            return inner
                .split(EOL)
                .map(line => stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line)
                .join(EOL);
        }
        case 'code': {
            if (!highlight) {
                return token.text + EOL;
            }
            let language = 'plaintext';
            if (token.lang) {
                if (highlight.supportsLanguage(token.lang)) {
                    language = token.lang;
                }
                else {
                    logForDebugging(`Language not supported while highlighting code, falling back to plaintext: ${token.lang}`);
                }
            }
            return highlight.highlight(token.text, { language }) + EOL;
        }
        case 'codespan': {
            // inline code
            return permissionColor(token.text);
        }
        case 'em':
            return chalk.italic((token.tokens ?? [])
                .map(_ => formatToken(_, 0, null, parent, highlight))
                .join(''));
        case 'strong':
            return chalk.bold((token.tokens ?? [])
                .map(_ => formatToken(_, 0, null, parent, highlight))
                .join(''));
        case 'heading':
            switch (token.depth) {
                case 1: // h1
                    return (chalk.bold.italic.underline((token.tokens ?? [])
                        .map(_ => formatToken(_, 0, null, null, highlight))
                        .join('')) +
                        EOL +
                        EOL);
                case 2: // h2
                    return (chalk.bold((token.tokens ?? [])
                        .map(_ => formatToken(_, 0, null, null, highlight))
                        .join('')) +
                        EOL +
                        EOL);
                default: // h3+
                    return (chalk.bold((token.tokens ?? [])
                        .map(_ => formatToken(_, 0, null, null, highlight))
                        .join('')) +
                        EOL +
                        EOL);
            }
        case 'hr':
            return '---';
        case 'image':
            return token.href;
        case 'link': {
            // Prevent mailto links from being displayed as clickable links
            if (token.href.startsWith('mailto:')) {
                // Extract email from mailto: link and display as plain text
                const email = token.href.replace(/^mailto:/, '');
                return email;
            }
            // Extract display text from the link's child tokens
            const linkText = (token.tokens ?? [])
                .map(_ => formatToken(_, 0, null, token, highlight))
                .join('');
            const plainLinkText = stripAnsi(linkText);
            // If the link has meaningful display text (different from the URL),
            // show it as a clickable hyperlink. In terminals that support OSC 8,
            // users see the text and can hover/click to see the URL.
            if (plainLinkText && plainLinkText !== token.href) {
                return createHyperlink(token.href, linkText);
            }
            // When the display text matches the URL (or is empty), just show the URL
            return createHyperlink(token.href);
        }
        case 'list': {
            return token.items
                .map((_, index) => formatToken(_, listDepth, token.ordered ? token.start + index : null, token, highlight))
                .join('');
        }
        case 'list_item':
            return (token.tokens ?? [])
                .map(_ => `${'  '.repeat(listDepth)}${formatToken(_, listDepth + 1, orderedListNumber, token, highlight)}`)
                .join('');
        case 'paragraph':
            return ((token.tokens ?? [])
                .map(_ => formatToken(_, 0, null, null, highlight))
                .join('') + EOL);
        case 'space':
            return EOL;
        case 'br':
            return EOL;
        case 'text':
            if (parent?.type === 'link') {
                // Already inside a markdown link — the link handler will wrap this
                // in an OSC 8 hyperlink. Linkifying here would nest a second OSC 8
                // sequence, and terminals honor the innermost one, overriding the
                // link's actual href.
                return token.text;
            }
            if (parent?.type === 'list_item') {
                return `${orderedListNumber === null ? '-' : getListNumber(listDepth, orderedListNumber) + '.'} ${token.tokens ? token.tokens.map(_ => formatToken(_, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}${EOL}`;
            }
            return linkifyIssueReferences(token.text);
        case 'table': {
            const tableToken = token;
            // Helper function to get the text content that will be displayed (after stripAnsi)
            function getDisplayText(tokens) {
                return stripAnsi(tokens
                    ?.map(_ => formatToken(_, 0, null, null, highlight))
                    .join('') ?? '');
            }
            // Determine column widths based on displayed content (without formatting)
            const columnWidths = tableToken.header.map((header, index) => {
                let maxWidth = stringWidth(getDisplayText(header.tokens));
                for (const row of tableToken.rows) {
                    const cellLength = stringWidth(getDisplayText(row[index]?.tokens));
                    maxWidth = Math.max(maxWidth, cellLength);
                }
                return Math.max(maxWidth, 3); // Minimum width of 3
            });
            // Format header row
            let tableOutput = '| ';
            tableToken.header.forEach((header, index) => {
                const content = header.tokens
                    ?.map(_ => formatToken(_, 0, null, null, highlight))
                    .join('') ?? '';
                const displayText = getDisplayText(header.tokens);
                const width = columnWidths[index];
                const align = tableToken.align?.[index];
                tableOutput +=
                    padAligned(content, stringWidth(displayText), width, align) + ' | ';
            });
            tableOutput = tableOutput.trimEnd() + EOL;
            // Add separator row
            tableOutput += '|';
            columnWidths.forEach((width) => {
                // Always use dashes, don't show alignment colons in the output
                const separator = '-'.repeat(width + 2); // +2 for spaces on each side
                tableOutput += separator + '|';
            });
            tableOutput += EOL;
            // Format data rows
            tableToken.rows.forEach((row) => {
                tableOutput += '| ';
                row.forEach((cell, index) => {
                    const content = cell.tokens
                        ?.map(_ => formatToken(_, 0, null, null, highlight))
                        .join('') ?? '';
                    const displayText = getDisplayText(cell.tokens);
                    const width = columnWidths[index];
                    const align = tableToken.align?.[index];
                    tableOutput +=
                        padAligned(content, stringWidth(displayText), width, align) + ' | ';
                });
                tableOutput = tableOutput.trimEnd() + EOL;
            });
            return tableOutput + EOL;
        }
        case 'escape':
            // Markdown escape: \) → ), \\ → \, etc.
            return token.text;
        case 'def':
        case 'del':
        case 'html':
            // These token types are not rendered
            return '';
    }
    return '';
}
// Matches owner/repo#NNN style GitHub issue/PR references. The qualified form
// is unambiguous — bare #NNN was removed because it guessed the current repo
// and was wrong whenever the assistant discussed a different one.
// Owner segment disallows dots (GitHub usernames are alphanumerics + hyphens
// only) so hostnames like docs.github.io/guide#42 don't false-positive. Repo
// segment allows dots (e.g. cc.kurs.web). Lookbehind is avoided — it defeats
// YARR JIT in JSC.
const ISSUE_REF_PATTERN = /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g;
/**
 * Replaces owner/repo#123 references with clickable hyperlinks to GitHub.
 */
function linkifyIssueReferences(text) {
    if (!supportsHyperlinks()) {
        return text;
    }
    return text.replace(ISSUE_REF_PATTERN, (_match, prefix, repo, num) => prefix +
        createHyperlink(`https://github.com/${repo}/issues/${num}`, `${repo}#${num}`));
}
function numberToLetter(n) {
    let result = '';
    while (n > 0) {
        n--;
        result = String.fromCharCode(97 + (n % 26)) + result;
        n = Math.floor(n / 26);
    }
    return result;
}
const ROMAN_VALUES = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
];
function numberToRoman(n) {
    let result = '';
    for (const [value, numeral] of ROMAN_VALUES) {
        while (n >= value) {
            result += numeral;
            n -= value;
        }
    }
    return result;
}
function getListNumber(listDepth, orderedListNumber) {
    switch (listDepth) {
        case 0:
        case 1:
            return orderedListNumber.toString();
        case 2:
            return numberToLetter(orderedListNumber);
        case 3:
            return numberToRoman(orderedListNumber);
        default:
            return orderedListNumber.toString();
    }
}
/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is the
 * visible width of `content` (caller computes this, e.g. via stringWidth on
 * stripAnsi'd text, so ANSI codes in `content` don't affect padding).
 * @param content - The text to pad, which may carry ANSI codes.
 * @param displayWidth - Visible width of `content` without ANSI codes.
 * @param targetWidth - Column width to pad `content` to.
 * @param align - Alignment: 'left', 'center', 'right', or null/undefined for left.
 * @returns `content` padded with spaces to `targetWidth`.
 */
export function padAligned(content, displayWidth, targetWidth, align) {
    const padding = Math.max(0, targetWidth - displayWidth);
    if (align === 'center') {
        const leftPad = Math.floor(padding / 2);
        return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad);
    }
    if (align === 'right') {
        return ' '.repeat(padding) + content;
    }
    return content + ' '.repeat(padding);
}
