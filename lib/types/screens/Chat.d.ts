import React from 'react';
import type { Channel } from '../dsh-adapter/channel.js';
import type { QuestionStore } from '../dsh-adapter/questions.js';
import { ApprovalStore } from '../dsh-adapter/approvals.js';
export declare function Chat({ channel, questionStore, approvalStore, onExit, onUpdate, }: {
    channel: Channel;
    questionStore: QuestionStore;
    /**
     * The approval seam's UI store. Optional: hosts without an approval
     * channel (headless scripts, older embeds) render Chat without it and
     * simply never see an approval panel — the question panel keeps its seat.
     */
    approvalStore?: ApprovalStore;
    onExit: () => void;
    /** Update the installed package and restart the current TUI process. */
    onUpdate?: () => void;
}): React.JSX.Element;
//# sourceMappingURL=Chat.d.ts.map