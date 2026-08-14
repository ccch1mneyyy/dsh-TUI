import { type Token } from 'marked';
import type { CliHighlight } from './cliHighlight.js';
/**
 * Strip tool-analysis XML tags (`<commit_analysis>`, `<context>`, `<function_analysis>`,
 * `<pr_analysis>`) and their contents, then trim the result.
 * @param content - Markdown text that may contain the wrapped tool-analysis tag blocks.
 * @returns The content with those blocks removed and surrounding whitespace trimmed.
 */
export declare function stripPromptXMLTags(content: string): string;
/**
 * Configure the shared `marked` instance once: disable strikethrough parsing so
 * `~100` renders literally instead of as deleted text.
 */
export declare function configureMarked(): void;
/**
 * Render markdown content to ANSI-styled text via the shared `marked` instance.
 * @param content - Markdown source to render.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string, trimmed.
 */
export declare function applyMarkdown(content: string, highlight?: CliHighlight | null): string;
/**
 * Render one marked token to ANSI text, recursing into child tokens.
 * @param token - The marked token to render.
 * @param listDepth - Nesting depth of the enclosing list; drives indentation and numbering style.
 * @param orderedListNumber - Current ordinal of the enclosing ordered list item, or null for unordered lists.
 * @param parent - The parent token; linkification is skipped inside links and prefixes are added inside list items.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string for the token, or '' for unrendered token types.
 */
export declare function formatToken(token: Token, listDepth?: number, orderedListNumber?: number | null, parent?: Token | null, highlight?: CliHighlight | null): string;
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
export declare function padAligned(content: string, displayWidth: number, targetWidth: number, align: 'left' | 'center' | 'right' | null | undefined): string;
//# sourceMappingURL=markdown.d.ts.map