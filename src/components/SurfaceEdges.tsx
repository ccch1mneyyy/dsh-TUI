import React from 'react'

/**
 * How many columns a surface may "bleed" past its own box on each side
 * (see the side-panel design doc §4.4). Structural chrome — page-level
 * dividers, the transcript gutter — runs straight to the surface edge
 * while content keeps its inset, the standard print-layout convention.
 *
 * PageMargin provides the default ({ left: x, right: x } of its inset).
 * SidePanelLayout re-provides per column: the chat column may bleed left
 * into the page margin but stops at the divider ({ left: x, right: 0 }),
 * the panel column vice versa ({ left: 0, right: x }).
 */
export interface SurfaceEdges {
  readonly left: number
  readonly right: number
}

export const NO_BLEED: SurfaceEdges = Object.freeze({ left: 0, right: 0 })

export const SurfaceEdgesContext = React.createContext<SurfaceEdges>(NO_BLEED)

/** Bleed allowance of the nearest surface (columns, per side). */
export function useSurfaceEdges(): SurfaceEdges {
  return React.useContext(SurfaceEdgesContext)
}
