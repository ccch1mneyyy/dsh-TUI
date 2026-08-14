type Output = {
    width: number;
    height: number;
};
/**
 * Measure wrapped text dimensions in a single pass.
 * @param text - the text to measure.
 * @param maxWidth - the wrap width in columns; non-positive or infinite disables wrapping.
 * @returns the widest line width and the number of visual lines.
 */
declare function measureText(text: string, maxWidth: number): Output;
export default measureText;
//# sourceMappingURL=measure-text.d.ts.map