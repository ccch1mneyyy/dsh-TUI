import React from 'react';
import type { Channel } from '../channel.js';
/**
 * Live goal + todo panel above the prompt input. Data rides on the channel:
 * `channel.goal` is folded from `goal/change` context events and
 * `channel.todos` from `todo/write` whole-list snapshots, so every model
 * update re-renders this panel in real time (no polling). Renders nothing
 * while both slots are empty.
 */
export declare function GoalTodoPanel({ channel }: {
    channel: Channel;
}): React.ReactNode;
//# sourceMappingURL=GoalTodoPanel.d.ts.map