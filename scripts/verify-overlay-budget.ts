import assert from 'node:assert/strict'
import { acceptOverlayMeasurement } from '../src/components/overlayBudget.js'

interface FeedResult {
  applied: number | undefined
  steps: number
  frozen: boolean
}

function feed(values: number[]): FeedResult {
  let applied: number | undefined
  let history: number[] = []
  let steps = 0
  let frozen = false

  for (const next of values) {
    if (acceptOverlayMeasurement(history, next, applied)) {
      history = history.length >= 2 ? [history[1], next] : [...history, next]
      applied = next
      steps++
    } else if (next !== applied) {
      frozen = true
    }
  }

  return { applied, steps, frozen }
}

assert.deepEqual(feed([10, 10, 10, 10]), {
  applied: 10,
  steps: 1,
  frozen: false,
})
assert.deepEqual(feed([10, 11, 12, 13, 14]), {
  applied: 14,
  steps: 5,
  frozen: false,
})
assert.deepEqual(feed([10, 10, 12, 12, 12]), {
  applied: 12,
  steps: 2,
  frozen: false,
})
assert.deepEqual(feed([30, 40, 30, 40, 30, 40]), {
  applied: 40,
  steps: 2,
  frozen: true,
})
assert.deepEqual(feed([10, 10, 10]), {
  applied: 10,
  steps: 1,
  frozen: false,
})

console.log('overlay budget verification passed')