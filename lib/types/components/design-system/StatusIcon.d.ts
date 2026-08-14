import React from 'react';
type Status = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading';
/**
 * A status indicator icon with the CC color mapping (ported from the leak's
 * design-system/StatusIcon.tsx): ✓ green / ✗ red / ⚠ amber / ℹ blue /
 * ○ dim / … dim.
 */
export declare function StatusIcon({ status, withSpace, }: {
    /** The status to display; determines both the icon and color. */
    status: Status;
    /** Include a trailing space after the icon. Useful when followed by text. */
    withSpace?: boolean;
}): React.ReactNode;
export {};
//# sourceMappingURL=StatusIcon.d.ts.map