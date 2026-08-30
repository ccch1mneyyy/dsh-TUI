/**
 * ScrollCoordinator — unified mathematical engine and state reconciler for TUI scrollboxes.
 *
 * Encapsulates:
 * 1. Wheel delta capping & inertia clamping
 * 2. Sticky state pinning & restoration
 * 3. Proportional thumb and track geometry
 * 4. Sticky prompt header visibility criteria
 */

export interface WheelDeltaInput {
  curTop: number
  curPending: number
  delta: number
  maxScroll: number
  viewportH: number
}

export interface WheelDeltaResult {
  handled: boolean
  setSticky: boolean
  nextPending: number
}

/**
 * Compute the next pending delta and stickiness from incoming wheel events.
 */
export function computeWheelDelta(input: WheelDeltaInput): WheelDeltaResult {
  const { curTop, curPending, delta, maxScroll, viewportH } = input

  // Clamp downward scroll when already at or past the bottom and already draining downwards
  if (delta > 0 && curTop >= maxScroll && curPending >= 0) {
    return {
      handled: true,
      setSticky: true,
      nextPending: 0,
    }
  }

  // Clamp upward scroll when already at top and already draining upwards
  if (delta < 0 && curTop <= 0 && curPending <= 0) {
    return {
      handled: true,
      setSticky: false,
      nextPending: 0,
    }
  }

  const targetTop = curTop + curPending + delta
  const clampedTarget = Math.max(0, Math.min(maxScroll, targetTop))
  const nextPending = clampedTarget - curTop

  if (delta > 0 && (curTop >= maxScroll || nextPending <= 0)) {
    return {
      handled: true,
      setSticky: true,
      nextPending: 0,
    }
  }

  if (delta < 0 && (curTop <= 0 || nextPending >= 0)) {
    return {
      handled: true,
      setSticky: false,
      nextPending: 0,
    }
  }

  const maxPending = Math.max(viewportH * 2, 40)
  const boundedPending = Math.max(-maxPending, Math.min(maxPending, nextPending))
  const setSticky = clampedTarget >= maxScroll

  return {
    handled: false,
    setSticky,
    nextPending: boundedPending,
  }
}

export interface ThumbGeometryInput {
  viewport: number
  content: number
  scrollTop: number
  maxScroll: number
}

export interface ThumbGeometry {
  thumbH: number
  trackH: number
  thumbTop: number
  thumbBottom: number
}

/**
 * Compute proportional scrollbar thumb and track bounds.
 */
export function computeThumbGeometry(input: ThumbGeometryInput): ThumbGeometry | null {
  const { viewport, content, scrollTop, maxScroll } = input
  if (viewport < 2 || content <= viewport) return null

  const thumbH = Math.max(2, Math.round((viewport * viewport) / content))
  const trackH = Math.max(1, viewport - thumbH)
  const currentScroll = Math.max(0, Math.min(maxScroll, scrollTop))
  const thumbTop = Math.min(trackH, Math.max(0, Math.round((currentScroll / Math.max(1, maxScroll)) * trackH)))
  const thumbBottom = Math.min(viewport, thumbTop + thumbH)

  return {
    thumbH,
    trackH,
    thumbTop,
    thumbBottom,
  }
}

/**
 * Map track row clicks back to a content-space scrollTop target.
 */
export function trackScrollTop(y: number, trackH: number, maxScroll: number): number {
  if (y <= 0) return 0
  if (y >= trackH) return maxScroll
  return Math.round((y / trackH) * maxScroll)
}

export interface StickyHeaderCriteria {
  isAtBottom: boolean
  hasAnchorText: boolean
  activeTurnTop: number | undefined
  scrollTop: number
  isFolded?: boolean
}

/**
 * Authoritative check for whether the sticky prompt header should be visible.
 */
export function shouldShowStickyHeader(criteria: StickyHeaderCriteria): boolean {
  if (criteria.isAtBottom || !criteria.hasAnchorText) return false
  if (criteria.isFolded) return true
  if (criteria.activeTurnTop === undefined) return false
  return criteria.activeTurnTop < criteria.scrollTop
}
