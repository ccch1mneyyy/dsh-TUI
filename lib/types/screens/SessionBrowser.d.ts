import React from 'react';
import type { Channel } from '../dsh-adapter/channel.js';
/**
 * The session browser — `/resume` as a screen of its own.
 *
 * The old picker was a panel of eight titles and a timestamp, and the reason
 * it could not be more than that was never layout: the data behind it was five
 * fields wide. With every session now arriving classified, sized, dated and
 * attributed, the surface that shows them can do the job a person actually
 * came for — find one conversation among many.
 *
 * What that means concretely:
 *
 * - Search is always live. There is no mode to enter; typing filters, because
 *   the list is the search results.
 * - Delegated sub-agent runs are folded away by default and revealed under
 *   their parents on demand. They are not noise to be deleted — they are the
 *   model's own work, and it is worth being able to open one — but they are
 *   not what "resume a conversation" means, and there are five of them for
 *   every conversation.
 * - Sessions that hold no conversation are never listed, only counted, with
 *   one action to clear them.
 * - The preview shows the end of a session, so "is this the one I was in the
 *   middle of" is answerable without resuming it.
 *
 * Every one of those reads bounded data, so the screen behaves the same on a
 * fifty-session history as on a five-session one.
 */
export declare function SessionBrowser({ channel, home, sameProject, onClose, }: {
    channel: Channel;
    /** Home directory, for collapsing project paths to `~`. */
    home: string;
    /** Whether a stored cwd belongs to the same project as the live session. */
    sameProject: (a: string, b: string) => boolean;
    onClose: () => void;
}): React.ReactNode;
//# sourceMappingURL=SessionBrowser.d.ts.map