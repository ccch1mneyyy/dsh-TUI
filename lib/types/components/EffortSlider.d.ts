import React from 'react';
import type { EffortOption } from '../dsh-adapter/channel.js';
/**
 * Reasoning-effort slider (`/effort`): a rheostat row of the live route's
 * adapter-owned levels in adapter order, ←/→ moving focus (each move applies
 * immediately through `channel.setEffort` — the slider IS the control; Enter
 * or Esc just closes it). The current level carries `✓`; the focused level's
 * description renders below the row.
 */
export declare function EffortSlider({ options, focusIndex, currentId, }: {
    options: readonly EffortOption[];
    focusIndex: number;
    currentId: string | undefined;
}): React.ReactNode;
//# sourceMappingURL=EffortSlider.d.ts.map