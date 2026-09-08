import React, { type PropsWithChildren } from 'react'
import Box, { type Props as BoxProps } from './Box.js'

type Props = PropsWithChildren<Omit<BoxProps, 'noSelect'> & { fromLeftEdge?: boolean }>

/** Exclude rendered cells from fullscreen copy selection, optionally including their left gutter. */
export function NoSelect({ fromLeftEdge, ...props }: Props) {
  return <Box {...props} noSelect={fromLeftEdge ? 'from-left-edge' : true} />
}
