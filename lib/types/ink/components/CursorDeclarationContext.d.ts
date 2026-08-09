import type { DOMElement } from '../dom.js';
export type CursorDeclaration = {
    /** Display column (terminal cell width) within the declared node */
    readonly relativeX: number;
    /** Line number within the declared node */
    readonly relativeY: number;
    /** The ink-box DOMElement whose yoga layout provides the absolute origin */
    readonly node: DOMElement;
};
/**
 * Setter for the declared cursor position.
 *
 * The optional second argument makes `null` a conditional clear: the
 * declaration is only cleared if the currently-declared node matches
 * `clearIfNode`. This makes the hook safe for sibling components
 * (e.g. list items) that transfer focus among themselves — without the
 * node check, a newly-unfocused item's clear could clobber a
 * newly-focused sibling's set depending on layout-effect order.
 */
export type CursorDeclarationSetter = (declaration: CursorDeclaration | null, clearIfNode?: DOMElement | null) => void;
declare const CursorDeclarationContext: any;
export default CursorDeclarationContext;
//# sourceMappingURL=CursorDeclarationContext.d.ts.map