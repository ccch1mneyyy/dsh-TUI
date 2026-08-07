/**
 * analyze-heapsnapshot.cjs — parse a V8 .heapsnapshot JSON and report the
 * top retainer types by total self size + count. Fast path: stream-parse
 * the nodes array only (edges skipped for speed on multi-GB files).
 *
 * Usage: node analyze-heapsnapshot.cjs <file.heapsnapshot> [topN]
 */
const fs = require('node:fs')

const file = process.argv[2]
const TOP = Number(process.argv[3] ?? 30)

const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
const { node_fields, node_types } = raw.snapshot.meta
const nodes = raw.nodes
const strings = raw.strings

const fType = node_fields.indexOf('type')
const fName = node_fields.indexOf('name')
const fSelf = node_fields.indexOf('self_size')
const fId = node_fields.indexOf('id')
const stride = node_fields.length

const typeNames = node_types[0]
const byKey = new Map() // "type::name" -> {count, bytes}

for (let i = 0; i < nodes.length; i += stride) {
  const type = typeNames[nodes[i + fType]]
  const name = strings[nodes[i + fName]]
  const self = nodes[i + fSelf]
  const key = `${type}::${name}`
  const e = byKey.get(key)
  if (e) { e.count++; e.bytes += self } else byKey.set(key, { count: 1, bytes: self })
}

const sorted = [...byKey.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
const totalBytes = [...byKey.values()].reduce((s, e) => s + e.bytes, 0)
console.log(`file: ${file}`)
console.log(`total self_size: ${(totalBytes / 1048576).toFixed(0)}MB across ${byKey.size} type/name groups`)
console.log('')
console.log('rank  MB       count    type::name')
for (let i = 0; i < Math.min(TOP, sorted.length); i++) {
  const [key, e] = sorted[i]
  console.log(
    `${String(i + 1).padStart(4)}  ${(e.bytes / 1048576).toFixed(1).padStart(7)}  ${String(e.count).padStart(8)}  ${key.slice(0, 110)}`,
  )
}
