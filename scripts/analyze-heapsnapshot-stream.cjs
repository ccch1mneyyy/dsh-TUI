/**
 * analyze-heapsnapshot-stream.cjs — two-pass streaming analyzer for huge
 * V8 .heapsnapshot files (>512MB, where JSON.parse fails).
 *
 * Pass 1: read the file tail to locate and parse "strings":[...].
 * Pass 2: stream-scan "nodes":[...] with a digit state machine, aggregating
 *         (type,name) groups without materializing the node list.
 *
 * Usage: node analyze-heapsnapshot-stream.cjs <file> [topN]
 */
const fs = require('node:fs')

const file = process.argv[2]
const TOP = Number(process.argv[3] ?? 30)
const fd = fs.openSync(file, 'r')
const size = fs.fstatSync(fd).size

function readAt(pos, len) {
  const buf = Buffer.alloc(len)
  fs.readSync(fd, buf, 0, len, pos)
  return buf
}

// --- meta: read the first 4KB (snapshot.meta lives at the top) ---
const head = readAt(0, 8192).toString('utf8')
const metaMatch = head.match(/"node_fields":\[(.*?)\].*?"node_types":\[\[(.*?)\]/s)
if (!metaMatch) { console.error('meta not found in head'); process.exit(1) }
const nodeFields = JSON.parse(`[${metaMatch[1]}]`)
const nodeTypes = JSON.parse(`[${metaMatch[2]}]`)
const fType = nodeFields.indexOf('type')
const fName = nodeFields.indexOf('name')
const fSelf = nodeFields.indexOf('self_size')
const stride = nodeFields.length
console.error(`meta: stride=${stride} type@${fType} name@${fName} self@${fSelf}`)

// --- pass 1: strings array (at ~1.43GB offset, ~50MB to EOF) ---
// Forward-scan in 8MB steps for the section markers.
function findMarker(needle, fromPos = 0) {
  const STEP = 8 * 1024 * 1024
  let prevTail = ''
  for (let pos = fromPos; pos < size; pos += STEP) {
    const len = Math.min(STEP, size - pos)
    const chunk = prevTail + readAt(pos, len).toString('latin1')
    const idx = chunk.indexOf(needle)
    if (idx >= 0) return pos - prevTail.length + idx
    prevTail = chunk.slice(-64)
  }
  return -1
}

const nodesStartRaw = findMarker('"nodes":[')
const edgesStart = findMarker('"edges":[')
const stringsMarker = findMarker('"strings":[')
if (nodesStartRaw < 0 || edgesStart < 0 || stringsMarker < 0) {
  console.error('markers not found', { nodesStartRaw, edgesStart, stringsMarker })
  process.exit(1)
}
const nodesStart = nodesStartRaw + '"nodes":['.length
const nodesEnd = edgesStart // nodes array ends right before '"edges":['
const stringsStart = stringsMarker + '"strings":'.length // points AT the '['
console.error(`nodes: ${nodesStart}..${nodesEnd}, strings at ${stringsStart}`)

// Parse strings: read [stringsStart, EOF), drop trailing '}' after the array.
const tailLen = size - stringsStart
console.error(`strings tail: ${(tailLen / 1048576).toFixed(0)}MB`)
let tailStr = readAt(stringsStart, tailLen).toString('utf8')
let end = tailStr.length - 1
while (end > 0 && tailStr[end] !== ']') end--
const strings = JSON.parse(tailStr.slice(0, end + 1))
console.error(`strings: ${strings.length} entries`)

// --- pass 2: nodes array stream scan (bounded by edges marker) ---

const agg = new Map() // (typeIdx << 40 | nameIdx) -> [count, bytes]
const CHUNK = 16 * 1024 * 1024
let pos = nodesStart
let numBuf = ''
let fieldIdx = 0
let curType = -1, curName = -1, curSelf = -1
let done = false
let nodeCount = 0

function flushNum() {
  if (numBuf.length === 0) return
  const v = Number(numBuf)
  numBuf = ''
  const slot = fieldIdx % stride
  if (slot === fType) curType = v
  else if (slot === fName) curName = v
  else if (slot === fSelf) curSelf = v
  fieldIdx++
  if (slot === stride - 1) {
    nodeCount++
    const key = curType * 2 ** 32 + curName
    const e = agg.get(key)
    if (e) { e[0]++; e[1] += curSelf } else agg.set(key, [1, curSelf])
  }
}

while (!done && pos < nodesEnd) {
  const len = Math.min(CHUNK, nodesEnd - pos)
  const buf = readAt(pos, len)
  pos += len
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c >= 48 && c <= 57) { numBuf += String.fromCharCode(c) }
    else if (c === 44) { flushNum() } // ','
    else if (c === 93) { flushNum(); done = true; break } // ']'
    // skip spaces/newlines
  }
}
fs.closeSync(fd)
console.error(`scanned ${nodeCount} nodes, ${agg.size} groups`)

const rows = [...agg.entries()]
  .map(([key, [count, bytes]]) => ({
    count,
    bytes,
    label: `${nodeTypes[Math.floor(key / 2 ** 32)]}::${strings[key % 2 ** 32]}`,
  }))
  .sort((a, b) => b.bytes - a.bytes)

const total = rows.reduce((s, r) => s + r.bytes, 0)
console.log(`\ntotal self_size: ${(total / 1048576).toFixed(0)}MB`)
console.log('rank  MB       count    type::name')
for (let i = 0; i < Math.min(TOP, rows.length); i++) {
  const r = rows[i]
  console.log(`${String(i + 1).padStart(4)}  ${(r.bytes / 1048576).toFixed(1).padStart(7)}  ${String(r.count).padStart(8)}  ${r.label.slice(0, 115)}`)
}
