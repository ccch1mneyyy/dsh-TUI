import React from 'react';
import type { PreviewEntry, SessionSummary } from '../../dsh-adapter/sessions/index.js';
/**
 * The preview pane: what this session actually says.
 *
 * It shows the END of the conversation, not the beginning, for two reasons.
 * The title already carries the beginning — it is usually the first prompt —
 * so repeating it would spend the pane on something the list already said. And
 * the question a person asks at this moment is "is this the one I was in the
 * middle of", which only the last exchange answers.
 *
 * It is also the reason the pane costs nothing: the tail of a log is exactly
 * what a bounded read already has in hand, so opening the preview on a 4 MB
 * session is the same amount of work as on a 40 KB one.
 */
export declare function SessionPreview({ session, entries, loading, width, height, home, now, }: {
    session: SessionSummary;
    entries: readonly PreviewEntry[];
    loading: boolean;
    width: number;
    height: number;
    home: string;
    now: number;
}): React.ReactNode;
//# sourceMappingURL=SessionPreview.d.ts.map