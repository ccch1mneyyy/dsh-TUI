import React from 'react';
import type { Tokens } from 'marked';
import type { CliHighlight } from '../cc/cliHighlight.js';
type Props = {
    token: Tokens.Table;
    highlight: CliHighlight | null;
    /** Override terminal width (useful for testing) */
    forceWidth?: number;
};
/**
 * Renders a markdown table with proper column sizing, cell wrapping and box
 * borders (ported from the leak's `MarkdownTable.tsx`). Falls back to a
 * vertical key-value format on narrow terminals.
 */
export declare function MarkdownTable({ token, highlight, forceWidth, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=MarkdownTable.d.ts.map