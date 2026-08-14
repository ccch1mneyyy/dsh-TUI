/**
 * Slice a string containing ANSI escape codes.
 *
 * Unlike the slice-ansi package, this properly handles OSC 8 hyperlink
 * sequences because @alcalzone/ansi-tokenize tokenizes them correctly.
 * @param str - The ANSI string to slice.
 * @param start - Start offset in display cells.
 * @param end - End offset in display cells; defaults to the end of `str`.
 * @returns The sliced string with its ANSI styling preserved.
 */
export default function sliceAnsi(str: string, start: number, end?: number): string;
//# sourceMappingURL=sliceAnsi.d.ts.map