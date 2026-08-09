import React from 'react';
import type { LoadedContext } from '../channel.js';
/**
 * The startup `已加载上下文` panel: a collapsed one-line summary of what a
 * fresh conversation will load for the current agent (system prompt
 * sections, workspace instruction files, dynamic context, skill catalog,
 * tools). Click the header to expand into the grouped details; the panel
 * renders only while the transcript is still empty — the first message's
 * rows take over. Renders nothing for an empty snapshot.
 * @param context - the channel's loaded-context snapshot.
 */
export declare function LoadedContextPanel({ context }: {
    context: LoadedContext;
}): React.ReactNode;
//# sourceMappingURL=LoadedContextPanel.d.ts.map