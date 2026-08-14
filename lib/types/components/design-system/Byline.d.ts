import React from 'react';
type Props = {
    /** The items to join with a middot separator */
    children: React.ReactNode;
};
/**
 * Joins children with a middot separator (" · ") for inline metadata display
 * (ported from the leak's design-system). Automatically filters out
 * null/undefined/false children and only renders separators between valid
 * elements.
 */
export declare function Byline({ children }: Props): React.ReactNode;
export {};
//# sourceMappingURL=Byline.d.ts.map