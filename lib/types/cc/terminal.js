import chalk from 'chalk';
import wrapAnsi from 'wrap-ansi';
/**
 * Terminal-width line truncation, ported from the leaked Claude Code source
 * (`src/utils/terminal.ts`). Renders long tool output as the first 3 wrapped
 * rows plus a `… +N lines (ctrl+o to expand)` hint.
 */
const PADDING_TO_PREVENT_OVERFLOW = 4;
const MAX_LINES_TO_SHOW = 3;
function wrapText(text, width) {
    const wrappedLines = wrapAnsi(text, width, {
        trim: false,
        hard: false,
        wordWrap: true,
    }).split('\n');
    const totalLines = wrappedLines.length;
    if (totalLines <= MAX_LINES_TO_SHOW) {
        return {
            aboveTheFold: wrappedLines.join('\n').trimEnd(),
            remainingLines: 0,
        };
    }
    const remainingLines = totalLines - MAX_LINES_TO_SHOW;
    // If there's only 1 line after the fold, show it directly
    // instead of showing "... +1 line (ctrl+o to expand)"
    if (remainingLines === 1) {
        return {
            aboveTheFold: wrappedLines
                .slice(0, MAX_LINES_TO_SHOW + 1)
                .join('\n')
                .trimEnd(),
            remainingLines: 0, // All lines are shown, nothing remaining
        };
    }
    // Otherwise show the standard MAX_LINES_TO_SHOW
    return {
        aboveTheFold: wrappedLines
            .slice(0, MAX_LINES_TO_SHOW)
            .join('\n')
            .trimEnd(),
        remainingLines: Math.max(0, remainingLines),
    };
}
/** `(ctrl+o to expand)` hint in dim chalk, like the leak's ctrlOToExpand().
 * @returns The dim hint text.
 */
export function ctrlOToExpand() {
    return chalk.dim('(ctrl+o to expand)');
}
/**
 * Renders the content with line-based truncation for terminal display.
 * If the content exceeds the maximum number of lines, it truncates the content
 * and adds a message indicating the number of additional lines.
 * @param content - Text to render; trailing whitespace is trimmed.
 * @param terminalWidth - Terminal width in columns; the wrap width reserves 4 columns of padding.
 * @param suppressExpandHint - When true, omit the `(ctrl+o to expand)` suffix from the overflow hint.
 * @returns The truncated text, or '' when `content` is blank after trimming.
 */
export function renderTruncatedContent(content, terminalWidth, suppressExpandHint = false) {
    const trimmedContent = content.trimEnd();
    if (!trimmedContent) {
        return '';
    }
    const wrapWidth = Math.max(terminalWidth - PADDING_TO_PREVENT_OVERFLOW, 10);
    // Only process enough content for the visible lines. Avoids O(n) wrapping
    // on huge outputs (e.g. 64MB binary dumps that cause 382K-row screens).
    const maxChars = MAX_LINES_TO_SHOW * wrapWidth * 4;
    const preTruncated = trimmedContent.length > maxChars;
    const contentForWrapping = preTruncated
        ? trimmedContent.slice(0, maxChars)
        : trimmedContent;
    const { aboveTheFold, remainingLines } = wrapText(contentForWrapping, wrapWidth);
    const estimatedRemaining = preTruncated
        ? Math.max(remainingLines, Math.ceil(trimmedContent.length / wrapWidth) - MAX_LINES_TO_SHOW)
        : remainingLines;
    return [
        aboveTheFold,
        estimatedRemaining > 0
            ? chalk.dim(`… +${estimatedRemaining} lines${suppressExpandHint ? '' : ` ${ctrlOToExpand()}`}`)
            : '',
    ]
        .filter(Boolean)
        .join('\n');
}
