/** Theme-native steady-state effort label for the status line. */
import React from 'react'
import { Text, useAnimationFrame } from '../ui.js'
import type { Theme } from '../theme.js'

// Shared Clock keeps its global 16ms cadence for every animation. This label
// only admits one React update per 112ms (≈8.9fps), without mutating the Clock.
const FRAME_MS = 112
// Five max positions (three letters + two dark gaps) × three frames gives a
// 1.68s complete warning-wave cycle; ultra's seven hues cycle in 784ms.
const MAX_PHASES = 3

const RAINBOW = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
] as const satisfies readonly (keyof Theme)[]

function staticColor(effort: string): keyof Theme {
  if (effort === 'xhigh') return 'permission'
  if (effort === 'high') return 'claude'
  return 'inactiveShimmer'
}

/**
 * Keep top effort tiers visibly charged after the one-shot input animation.
 * Only max/ultra subscribe to Ink's shared, viewport-aware clock; its global
 * cadence stays untouched while this component gates React work to about 9fps.
 * All other tiers are static and add no animation work.
 */
export function PersistentEffortLabel({ effort }: { effort: string }): React.ReactNode {
  const tier = effort.toLowerCase()
  const active = tier === 'max' || tier === 'ultra'
  const [ref, time] = useAnimationFrame(active ? FRAME_MS : null)

  if (tier !== 'max' && tier !== 'ultra') {
    return <Text color={staticColor(tier)}>{effort}</Text>
  }

  const chars = Array.from(effort)
  const frame = Math.floor(time / FRAME_MS)
  return (
    <Text ref={ref} wrap="truncate">
      {chars.map((char, index) => {
        const color: keyof Theme = tier === 'max'
          ? ((index + Math.floor(frame / MAX_PHASES)) % (chars.length + 2) === 0 ? 'warningShimmer' : 'warning')
          : RAINBOW[(index + frame) % RAINBOW.length]!
        return <Text key={index} color={color}>{char}</Text>
      })}
    </Text>
  )
}
