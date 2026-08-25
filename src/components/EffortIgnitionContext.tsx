import React from 'react'
import type { EffortIgnitionStyle } from '../trajectory/effortIgnition.js'

/** One prompt-owned ignition frame shared by the border, badge, and prefix. */
export interface EffortIgnitionFrame {
  readonly label: string
  readonly style: EffortIgnitionStyle
  readonly elapsedMs: number
  readonly durationMs: number
}

/** Null outside an active, bounded effort transition. */
export const EffortIgnitionContext = React.createContext<EffortIgnitionFrame | null>(null)
