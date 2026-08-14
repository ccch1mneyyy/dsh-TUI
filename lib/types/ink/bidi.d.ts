type ClusteredChar = {
    value: string;
    width: number;
    styleId: number;
    hyperlink: string | undefined;
};
/**
 * Reorder an array of ClusteredChars from logical order to visual order
 * using the Unicode Bidi Algorithm. Active on terminals that lack native
 * bidi support (Windows Terminal, conhost, WSL).
 *
 * Returns the same array on bidi-capable terminals (no-op).
 * @param characters - clustered chars in logical order.
 * @returns the characters in visual order, or the same array when no reordering applies.
 */
export declare function reorderBidi(characters: ClusteredChar[]): ClusteredChar[];
export {};
//# sourceMappingURL=bidi.d.ts.map