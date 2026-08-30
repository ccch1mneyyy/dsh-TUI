#!/usr/bin/env node
/** Summarize a DSH_TUI_GEOMETRY_TRACE jsonl: per-frame cause + list window + scroll geometry. */
import { readFileSync } from 'node:fs'
const lines = readFileSync(process.argv[2] ?? 'trace.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const limit = Number(process.argv[3] ?? Infinity)
let i = 0
for (const e of lines) {
  if (i++ >= limit) break
  const l = e.list
  const listStr = l ? `s${l.start}-e${l.end}/${l.rowCount} vp${l.viewport} top${l.topPad} bot${l.bottomPad} tot${l.total} sticky${l.sticky ? 1 : 0}` : '-'
  const scrollStr = (e.scroll ?? []).map(s => `st${s.scrollTop}/${s.renderScrollTop} h${s.scrollHeight}/max${s.maxScroll} stky${s.sticky ? 1 : 0} grew${s.grew ? 1 : 0}`).join(' ')
  console.log(`f${e.frame} ${String(e.cause).padEnd(12)} ${String(e.ms).padStart(5)}ms | ${listStr} | ${scrollStr}`)
}
console.log(`total frames=${lines.length}`)
