import React, { type ReactNode } from 'react'
import { supportsHyperlinks } from '../supports-hyperlinks.js'
import Text from './Text.js'

export type Props = { readonly children?: ReactNode; readonly url: string; readonly fallback?: ReactNode }

export default function Link({ children, url, fallback }: Props) {
  const label = children ?? url
  return <Text>{supportsHyperlinks() ? <ink-link href={url}>{label}</ink-link> : (fallback ?? label)}</Text>
}
