import React from 'react'

export type Props = { readonly count?: number }

/** Insert line separators inside a text container. */
export default function Newline({ count = 1 }: Props) {
  return <ink-text>{'\n'.repeat(count)}</ink-text>
}
