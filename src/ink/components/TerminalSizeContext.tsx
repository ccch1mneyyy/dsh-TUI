import { createContext } from 'react';
export type TerminalSize = {
  columns: number;
  rows: number;
  /** Rows of the REAL screen viewport. Narrowing surfaces (PageMargin,
   *  the side-panel columns and hosts) shrink `rows` for layout math but
   *  forward the outer `screenRows` unchanged, so viewport-visibility
   *  logic (useTerminalViewport → useAnimationFrame) still measures
   *  against the screen the terminal actually shows. Root providers leave
   *  it undefined and consumers fall back to `rows`. */
  screenRows?: number;
};
export const TerminalSizeContext = createContext<TerminalSize | null>(null);
