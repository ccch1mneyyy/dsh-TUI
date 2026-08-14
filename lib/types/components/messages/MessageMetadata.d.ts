import React from 'react';
type Props = {
    /** Wall-clock ms of the assistant message event. */
    timestamp?: number;
    /** Model id shown next to the time (session model). */
    model: string;
};
/**
 * Transcript-mode metadata row: `HH:MM · model`, right-aligned above the
 * assistant text (ported from the leak's MessageTimestamp + MessageModel,
 * collapsed into one row).
 */
export declare function MessageMetadata({ timestamp, model, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=MessageMetadata.d.ts.map