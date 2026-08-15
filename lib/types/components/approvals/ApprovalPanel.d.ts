/**
 * The approval panel — Claude Code style permission prompt for the DSH
 * approval seam (`ctx.approval`). One ask per panel: a permission-colored
 * divider header naming the tool, the gated command recovered from the
 * paired tool call (CC verbose full-command semantics), the asker's reason,
 * "Do you want to proceed?", and a numbered Yes/No list.
 *
 * The protocol's outcome set is closed (allowed-once / rejected /
 * cancelled / unavailable) with no allow-always or feedback channel, so
 * the panel deliberately offers exactly two rows; Esc and Ctrl+C reject
 * (fail closed, CC's "Esc to cancel" semantics).
 */
import React from 'react';
import type { ApprovalSnapshot } from '../../dsh-adapter/approvals.js';
export type ApprovalPanelProps = {
    /** The approval to render (from the ApprovalStore snapshot). */
    readonly approval: ApprovalSnapshot;
    readonly onDecide: (outcome: 'allowed-once' | 'rejected') => void;
};
export declare function ApprovalPanel({ approval, onDecide }: ApprovalPanelProps): React.ReactNode;
//# sourceMappingURL=ApprovalPanel.d.ts.map