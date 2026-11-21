import React from 'react'
import { ProgressBar } from './ProgressBar.js'
import Text from './ThemedText.js'
import { chartColorKey } from './chartColor.js'
import { cellCount, chartValue } from './chartGeometry.js'
import type { TuiMeterProps } from './chartTypes.js'

/**
 * One-ratio bar (`ui.Meter`): the public face of the design-system
 * `ProgressBar`, with the kit's input rules — the ratio is sanitized and
 * clamped to 0…1, the width to whole cells, and colors must be palette slots
 * or theme keys (anything else falls back to the default text color / no
 * track). The empty part is a background fill in `emptyColor`, so leave it
 * unset for a bare fill. Like the other one-row primitives it truncates
 * rather than wraps in a container narrower than `width`.
 */
export const Meter = React.memo(function Meter({ ratio, width, fillColor, emptyColor }: TuiMeterProps): React.ReactNode {
  const cells = cellCount(width)
  if (cells === 0) return null
  return (
    <Text wrap="truncate-end">
      <ProgressBar
        ratio={Math.min(1, chartValue(ratio))}
        width={cells}
        fillColor={chartColorKey(fillColor)}
        emptyColor={chartColorKey(emptyColor)}
      />
    </Text>
  )
})
