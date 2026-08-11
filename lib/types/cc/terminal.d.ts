/** `(ctrl+o to expand)` hint in dim chalk, like the leak's ctrlOToExpand().
 * @returns The dim hint text.
 */
export declare function ctrlOToExpand(): string;
/**
 * Renders the content with line-based truncation for terminal display.
 * If the content exceeds the maximum number of lines, it truncates the content
 * and adds a message indicating the number of additional lines.
 * @param content - Text to render; trailing whitespace is trimmed.
 * @param terminalWidth - Terminal width in columns; the wrap width reserves 4 columns of padding.
 * @param suppressExpandHint - When true, omit the `(ctrl+o to expand)` suffix from the overflow hint.
 * @returns The truncated text, or '' when `content` is blank after trimming.
 */
export declare function renderTruncatedContent(content: string, terminalWidth: number, suppressExpandHint?: boolean): string;
//# sourceMappingURL=terminal.d.ts.map