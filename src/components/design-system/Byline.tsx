import React, { Children, isValidElement } from 'react'
import Text from '../../ink/components/Text.js'

type Props = {
  /** The items to join with a middot separator */
  children: React.ReactNode
}

/**
 * Joins children with a middot separator (" · ") for inline metadata display
 * (ported from the leak's design-system). Automatically filters out
 * null/undefined/false children and only renders separators between valid
 * elements.
 */
export function Byline({ children }: Props): React.ReactNode {
  // Children.toArray already filters out null, undefined, and booleans
  const validChildren = Children.toArray(children)

  if (validChildren.length === 0) {
    return null
  }

  return (
    <>
      {validChildren.map((child, index) => (
        <React.Fragment
          key={isValidElement(child) ? (child.key ?? index) : index}
        >
          {index > 0 && <Text dimColor> · </Text>}
          {child}
        </React.Fragment>
      ))}
    </>
  )
}
