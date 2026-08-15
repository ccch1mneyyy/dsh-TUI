/**
 * The plan-review panel — Claude Code style exit-plan-mode decision card
 * for the DSH user-interaction seam. plan-mode's `exit_plan_mode` tool asks
 * through `ctx.userQuestions` with `intent: { kind: 'plan-review',
 * approve }`: the plan markdown arrives in `detail`, the approve/decline
 * choices in `options` (labels verbatim — the protocol answers with the
 * asker's own labels).
 *
 * Protocol-exact answer mapping (dsh-plan-mode):
 * - Approve: `{ selected: [intent.approve] }` — custom MUST be absent, or
 *   plan-mode treats it as keep-planning-with-feedback.
 * - Keep planning / feedback: `{ selected: [declineLabel], custom? }` where
 *   declineLabel is the first option that is not the approve label.
 * - Esc / Ctrl+C: the store rejects with ASK_CANCELLED, which plan-mode
 *   reads as "the user dismissed the review to speak instead".
 */
import React from 'react';
import type { QuestionSelection } from '../../dsh-adapter/questions.js';
export type PlanReviewPanelProps = {
    /** The plan-review question (intent.kind === 'plan-review'). */
    readonly question: {
        readonly question: string;
        readonly header?: string;
        readonly detail?: string;
        readonly options?: ReadonlyArray<{
            readonly label: string;
            readonly description?: string;
        }>;
        readonly intent?: {
            readonly kind: 'plan-review';
            readonly approve: string;
        };
    };
    readonly onAnswer: (selection: QuestionSelection) => void;
    /** Esc / Ctrl+C — dismissed to speak instead (ASK_CANCELLED). */
    readonly onCancel: () => void;
};
export declare function PlanReviewPanel({ question, onAnswer, onCancel, }: PlanReviewPanelProps): React.ReactNode;
//# sourceMappingURL=PlanReviewPanel.d.ts.map