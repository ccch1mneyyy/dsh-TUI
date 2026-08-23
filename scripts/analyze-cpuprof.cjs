/** 聚合 cpuprofile：自耗时 top 函数。用法：node scripts/analyze-cpuprof.cjs <file.cpuprofile> */
const fs = require('fs')
const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const byId = new Map(prof.nodes.map(n => [n.id, n]))
const self = new Map()
const totalWeight = prof.samples.length
for (let i = 0; i < prof.samples.length; i++) {
  const id = prof.samples[i]
  const n = byId.get(id)
  if (!n) continue
  const f = n.callFrame
  const key = `${f.functionName || '(anon)'} ${f.url ? f.url.split('/').slice(-2).join('/') : ''}:${f.lineNumber + 1}`
  self.set(key, (self.get(key) ?? 0) + 1)
}
const sorted = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
console.log(`总样本=${totalWeight} (~${(totalWeight / 100).toFixed(1)}s @100Hz)`)
for (const [k, v] of sorted) {
  console.log(`${(v / totalWeight * 100).toFixed(1).padStart(5)}%  ${(v / 100).toFixed(2)}s  ${k}`)
}
