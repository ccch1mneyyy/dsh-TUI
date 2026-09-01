import {
  computeWheelDelta,
  computeThumbGeometry,
  shouldShowStickyHeader,
  trackScrollTop,
} from '../src/ink/scroll-coordinator.js'

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ` (${extra})` : ''}`)
  if (!ok) failed += 1
}

// 1. computeWheelDelta test cases
{
  // At bottom (curTop=30, maxScroll=30, curPending=0), scrolling down (+5)
  const res1 = computeWheelDelta({ curTop: 30, curPending: 0, delta: 5, maxScroll: 30, viewportH: 20 })
  check('wheel down at bottom stops delta and restores sticky', res1.handled && res1.setSticky && res1.nextPending === 0)

  // At top (curTop=0, curPending=0), scrolling up (-5)
  const res2 = computeWheelDelta({ curTop: 0, curPending: 0, delta: -5, maxScroll: 30, viewportH: 20 })
  check('wheel up at top stops delta', res2.handled && res2.nextPending === 0)

  // Mid scroll (curTop=10, maxScroll=30, curPending=0), scrolling down (+5)
  const res3 = computeWheelDelta({ curTop: 10, curPending: 0, delta: 5, maxScroll: 30, viewportH: 20 })
  check('wheel down mid scroll advances pending delta', !res3.handled && res3.nextPending === 5 && !res3.setSticky)

  // Wheel down burst reaching maxScroll (curTop=20, maxScroll=30, delta=20)
  const res4 = computeWheelDelta({ curTop: 20, curPending: 0, delta: 20, maxScroll: 30, viewportH: 20 })
  check('wheel burst reaching maxScroll clamps pending to 10 and sets sticky', !res4.handled && res4.nextPending === 10 && res4.setSticky)
}

// 2. computeThumbGeometry test cases
{
  // Content fits within viewport (viewport=24, content=20)
  const geo1 = computeThumbGeometry({ viewport: 24, content: 20, scrollTop: 0, maxScroll: 0 })
  check('content fits in viewport returns null geometry', geo1 === null)

  // Content 60, viewport 24, maxScroll 36, scrollTop 0
  const geo2 = computeThumbGeometry({ viewport: 24, content: 60, scrollTop: 0, maxScroll: 36 })
  check('thumb geometry at top', geo2 !== null && geo2.thumbTop === 0 && geo2.thumbH >= 2)

  // Content 60, viewport 24, maxScroll 36, scrollTop 36 (at bottom)
  const geo3 = computeThumbGeometry({ viewport: 24, content: 60, scrollTop: 36, maxScroll: 36 })
  check('thumb geometry at bottom clamps thumbTop to trackH', geo3 !== null && geo3.thumbTop === geo3.trackH && geo3.thumbBottom === 24)

  // Track scroll position mapper
  if (geo2) {
    const topScroll = trackScrollTop(0, geo2.trackH, 36)
    const bottomScroll = trackScrollTop(geo2.trackH, geo2.trackH, 36)
    check('trackScrollTop top', topScroll === 0)
    check('trackScrollTop bottom', bottomScroll === 36)
  }
}

// 3. shouldShowStickyHeader test cases
{
  // At bottom
  check('shouldShowStickyHeader returns false when at bottom', !shouldShowStickyHeader({
    isAtBottom: true,
    hasAnchorText: true,
    activeTurnTop: 0,
    scrollTop: 10,
    isFolded: false,
  }))

  // No anchor text
  check('shouldShowStickyHeader returns false without anchor text', !shouldShowStickyHeader({
    isAtBottom: false,
    hasAnchorText: false,
    activeTurnTop: 0,
    scrollTop: 10,
    isFolded: false,
  }))

  // Active turn is folded
  check('shouldShowStickyHeader returns true when active turn is folded', shouldShowStickyHeader({
    isAtBottom: false,
    hasAnchorText: true,
    activeTurnTop: -1,
    scrollTop: 10,
    isFolded: true,
  }))

  // Active turn is scrolled off above (activeTurnTop=5, scrollTop=15)
  check('shouldShowStickyHeader returns true when turn top < scrollTop', shouldShowStickyHeader({
    isAtBottom: false,
    hasAnchorText: true,
    activeTurnTop: 5,
    scrollTop: 15,
    isFolded: false,
  }))

  // Active turn prompt is visible in viewport (activeTurnTop=15, scrollTop=10)
  check('shouldShowStickyHeader returns false when turn prompt is visible in viewport', !shouldShowStickyHeader({
    isAtBottom: false,
    hasAnchorText: true,
    activeTurnTop: 15,
    scrollTop: 10,
    isFolded: false,
  }))
}

if (failed > 0) {
  console.error(`Verification failed with ${failed} errors.`)
  process.exit(1)
} else {
  console.log('All ScrollCoordinator tests passed cleanly.')
  process.exit(0)
}
