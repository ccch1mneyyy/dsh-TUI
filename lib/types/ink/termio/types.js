/**
 * ANSI Parser - Semantic Types
 *
 * These types represent the semantic meaning of ANSI escape sequences,
 * not their string representation. Inspired by ghostty's action-based design.
 */
/**
 * Create a default (reset) text style.
 * @returns a TextStyle with every attribute at its reset value.
 */
export function defaultStyle() {
    return {
        bold: false,
        dim: false,
        italic: false,
        underline: 'none',
        blink: false,
        inverse: false,
        hidden: false,
        strikethrough: false,
        overline: false,
        fg: { type: 'default' },
        bg: { type: 'default' },
        underlineColor: { type: 'default' },
    };
}
/**
 * Check if two styles are equal.
 * @param a - the first style.
 * @param b - the second style.
 * @returns true when every attribute and color of the two styles matches.
 */
export function stylesEqual(a, b) {
    return (a.bold === b.bold &&
        a.dim === b.dim &&
        a.italic === b.italic &&
        a.underline === b.underline &&
        a.blink === b.blink &&
        a.inverse === b.inverse &&
        a.hidden === b.hidden &&
        a.strikethrough === b.strikethrough &&
        a.overline === b.overline &&
        colorsEqual(a.fg, b.fg) &&
        colorsEqual(a.bg, b.bg) &&
        colorsEqual(a.underlineColor, b.underlineColor));
}
/**
 * Check if two colors are equal.
 * @param a - the first color.
 * @param b - the second color.
 * @returns true when the two colors have the same type and value.
 */
export function colorsEqual(a, b) {
    if (a.type !== b.type)
        return false;
    switch (a.type) {
        case 'named':
            return a.name === b.name;
        case 'indexed':
            return a.index === b.index;
        case 'rgb':
            return (a.r === b.r &&
                a.g === b.g &&
                a.b === b.b);
        case 'default':
            return true;
    }
}
