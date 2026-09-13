import React from 'react'

type Props = { lines: string[]; width: number }

/** Already wrapped terminal rows, measured without creating a tree per style span. */
export const RawAnsi = React.memo(function RawAnsi({ lines, width }: Props) {
  const rawText = React.useMemo(() => lines.join('\n'), [lines])
  return lines.length ? <ink-raw-ansi rawText={rawText} rawWidth={width} rawHeight={lines.length} /> : null
})
