import React from 'react'
import Box from './Box.js'

/** Consume unused space on the parent's flex axis. */
export default function Spacer() {
  return <Box flexGrow={1} />
}
