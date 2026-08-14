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
 * Tool-call card: `● Edit /path` header with a blinking status dot, then the
 * structured body under a `  ⎿  ` gutter — diff hunks in red/green, terminal
 * output, read content — instead of the raw result dump (ported from the
 * leak's `AssistantToolUseMessage.tsx` + the dsh-tools presentation views the
 * channel captures per call).
 */
export declare function AssistantToolUseMessage({ tool, addMargin, verbose, isSelected, isExpanded, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=AssistantToolUseMessage.d.ts.map