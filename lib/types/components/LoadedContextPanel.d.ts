import React from 'react';
import type { LoadedContext } from '../channel.js';
/**
 * The startup context panel: a collapsed one-line summary of what a
 * fresh conversation will load for the current agent (system prompt
 * sections, workspace instruction files, dynamic context, skill catalog,
 * tools). Toggle with Ctrl+T (see HelpMenu; the ported ink core has no
 * mouse-click handling, so the header is not clickable); the panel renders
 * only while the transcript is still empty — the first message's rows take
 * over. Renders nothing for an empty snapshot.
 * @param context - the channel's loaded-context snapshot.
 * @param open - whether the grouped details are shown.
 * @param onToggle - flips `open`; fired by the Ctrl+T keybinding.
 */
export declare function LoadedContextPanel({ context, open, onToggle, }: {
    context: LoadedContext;
    open: boolean;
    onToggle: () => void;
}): React.ReactNode;
//# sourceMappingURL=LoadedContextPanel.d.ts.map