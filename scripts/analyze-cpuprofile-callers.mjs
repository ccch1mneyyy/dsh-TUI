#!/usr/bin/env node
/** Aggregate .cpuprofile by (function, caller) pairs — attributes self time
 *  to the immediate parent, exposing WHO drives a hot leaf like stringWidth. */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const filter = process.argv[3] ?? '' // substring filter on leaf function name
const profile = JSON.parse(readFileSync(file, 'utf8'))
const { nodes, samples, timeDeltas } = profile
const byId = new Map(nodes.map(n => [n.id, n]))
const parent = new Map()
for (const n of nodes) for (const c of n.children ?? []) parent.set(c, n)
const self = new Map()
let t = 0
for (let i = 0; i < samples.length; i++) {
  t += timeDeltas[i] ?? 0
  const id = samples[i]
  self.set(id, (self.get(id) ?? 0) + (timeDeltas[i] ?? 0))
}
const agg = new Map() // parentKey -> µs
for (const [id, us] of self) {
  const n = byId.get(id)
  if (!n) continue
  const fname = n.callFrame.functionName || '(anon)'
  if (filter && !fname.includes(filter)) continue
  const p = parent.get(id)
  const pc = p?.callFrame
  const pkey = p ? `${pc.functionName || '(anon)'} @ ${(pc.url || '').replace(/^.*(node_modules|dsh-tui)\//, '')}:${pc.lineNumber + 1}` : '(root)'
  agg.set(pkey, (agg.get(pkey) ?? 0) + us)
}
const rows = [...agg.entries()].sort((a, b) => b[1] - a[1])
console.log(`filter='${filter}' — self time grouped by caller`)
for (const [k, us] of rows.slice(0, 20)) console.log(`${(us / 1000).toFixed(0).padStart(7)}ms  ${k}`)
