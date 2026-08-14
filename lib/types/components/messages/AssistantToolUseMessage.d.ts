import React from 'react';
import type { ToolRow } from '../../channel.js';
type Props = {
    tool: ToolRow;
    /** Adds the top margin between messages (CC: addMargin). */
    addMargin: boolean;
    /** Ctrl+O verbose: show full args/result instead of previews. */
    verbose: boolean;
    /** Message-selection mode highlight. */
    isSelected?: boolean;
    /** Row expanded on its own (persistent hover-grey background, CC). */
    isExpanded?: boolean;
};
/**
 * Tool-call card: `● Bash("args")` header with a blinking status dot, then a
 * `Running…`/result/error line (ported from the leak's
 * `AssistantToolUseMessage.tsx` + the BashTool UI, collapsed into one card
 * because cc-tui's channel settles tool/result into a single row).
 */
export declare function AssistantToolUseMessage({ tool, addMargin, verbose, isSelected, isExpanded, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=AssistantToolUseMessage.d.ts.map