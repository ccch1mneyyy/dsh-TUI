#!/usr/bin/env node
/** Parse a V8 .cpuprofile: top self-time functions within a time window. */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const sinceMs = Number(process.argv[3] ?? 0) // only samples with delta >= since (µs)
const profile = JSON.parse(readFileSync(file, 'utf8'))
const { nodes, samples, timeDeltas } = profile
const byId = new Map(nodes.map(n => [n.id, n]))
const self = new Map() // nodeId -> µs
const total = new Map()
let t = 0
for (let i = 0; i < samples.length; i++) {
  const d = timeDeltas[i] ?? 0
  t += d
  if (t < sinceMs * 1000) continue
  const id = samples[i]
  self.set(id, (self.get(id) ?? 0) + d)
}
// attribute to function key
const rows = []
for (const [id, us] of self) {
  const n = byId.get(id)
  if (!n) continue
  const cf = n.callFrame
  const key = `${cf.functionName || '(anon)'} @ ${(cf.url || '').replace(/^.*node_modules\//, 'nm/').replace(/^.*dsh-tui./, '')}:${cf.lineNumber + 1}`
  rows.push([key, us])
}
rows.sort((a, b) => b[1] - a[1])
console.log(`samples=${samples.length} window>=${sinceMs}ms`)
for (const [k, us] of rows.slice(0, 30)) {
  console.log(`${(us / 1000).toFixed(0).padStart(7)}ms  ${k}`)
}
