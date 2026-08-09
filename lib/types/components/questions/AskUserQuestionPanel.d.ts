/**
 * The questionnaire panel — Claude Code style ask-user-question UI for the
 * DSH user-interaction seam. One question per panel (progress header, header
 * chip, wrapped question text, optional detail, option list with focus
 * pointer and multi-select checkmarks, free-text "Other" mode), styled in
 * the cc-tui mist-blue design language.
 */
import React from 'react';
import type { QuestionSelection } from '../../questions.js';
export type AskUserQuestionPanelProps = {
    /** The question to render (from the QuestionStore snapshot). */
    readonly question: {
        readonly question: string;
        readonly header?: string;
        readonly detail?: string;
        readonly options?: ReadonlyArray<{
            readonly label: string;
            readonly description?: string;
        }>;
        readonly multiSelect?: boolean;
    };
    /** 1-based position within the batch (progress header). */
    readonly position: number;
    /** Total questions in the batch (progress header). */
    readonly total: number;
    /** Questions answered before the current one. */
    readonly answered: number;
    readonly onAnswer: (selection: QuestionSelection) => void;
    /** Esc / Ctrl+C — aborts the whole ask (ASK_ABORTED back to the model). */
    readonly onCancel: () => void;
};
export declare function AskUserQuestionPanel({ question, position, total, answered, onAnswer, onCancel, }: AskUserQuestionPanelProps): React.ReactNode;
//# sourceMappingURL=AskUserQuestionPanel.d.ts.map