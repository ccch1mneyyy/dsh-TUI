import React from 'react';
import { type ScrollBoxHandle } from '../ui.js';
import type { ChatRow } from '../channel.js';
import type { DOMElement } from '../ink/dom.js';
export declare function MessageList({ rows, expanded, expandedRows, selectedId, onToggleRow, model, showAll, onToggleAll, onLoadOlder, thinkingVisible, registerRowRef, scrollHandle, forceMountRowId, newSinceRowId, onUnseenCount, }: {
    rows: readonly ChatRow[];
    expanded: boolean;
    expandedRows: ReadonlySet<number>;
    selectedId: number | null;
    onToggleRow: (rowId: number) => void;
    model: string;
    showAll: boolean;
    onToggleAll: () => void;
    /** Restore folded-away older rows from the session log (CC-style "load
     *  earlier messages" affordance; shown only when rows were folded). */
    onLoadOlder?: () => void;
    thinkingVisible?: boolean;
    /** Transcript search: register each row's DOM element for scroll-to-match. */
    registerRowRef?: (rowId: number, el: DOMElement | null) => void;
    /** Scroll viewport the list virtualizes against. */
    scrollHandle?: ScrollBoxHandle | null;
    /** Row that must be mounted this pass (seek target for scrollToElement). */
    forceMountRowId?: number | null;
    /** "Seen up to" anchor for the new-messages pill: rows with id greater
     *  than this are new. Null when pinned to the bottom (nothing unseen). */
    newSinceRowId?: number | null;
    /** Reports how many new rows still sit below the viewport bottom edge. */
    onUnseenCount?: (count: number) => void;
}): React.JSX.Element;
/**
 * The header block pinned above the transcript: the DeepSeek pixel whale
 * with the wordmark, tagline, model/effort and cwd (`LogoV2`), plus the
 * welcome line. It scrolls away with the transcript once the conversation
 * fills the viewport (Claude Code shows its ✦ logo in the same slot).
 */
export declare function LogoHeader({ model, effort, cwd, }: {
    model: string;
    effort?: string | undefined;
    cwd: string;
}): React.ReactNode;
//# sourceMappingURL=MessageList.d.ts.map