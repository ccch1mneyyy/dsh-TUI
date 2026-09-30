/**
 * probe-foreign-browse — 外部来源浏览层性能探针（读本机真实数据，只读源；
 * 导入写进临时目录，不碰 ~/.dsh）。不是有界测试，不登记 CI；数字用于 PR
 * 描述与 docs/foreign-session-tabs-design.md §5.2 的性能目标对照：
 *   - 打开会话屏的代价：来源存在性探测（每个来源走到第一个候选即停）；
 *   - 进入来源标签：冷列出（本进程第一次）与再次列出（指纹全部未变）；
 *   - 单会话导入：每个来源取最近一条，load + sessionize + 官方持久化落盘。
 * 每项同时报告事件循环的最长停顿（界面会感到的卡顿）。
 *
 * 运行：node --import tsx/esm scripts/probe-foreign-browse.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createForeignBrowser } = await import('../src/dsh-adapter/migrate/browse.js')
const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const { Context } = await import('@deepseek-ai/cordis')

const scratch = mkdtempSync(join(tmpdir(), 'probe-foreign-browse-'))
const rows = []

/** Run `work` while sampling the event loop every 5ms; report wall time and the worst stall. */
async function measure(name, work) {
  let worst = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 5)
    last = now
  }, 5)
  const start = performance.now()
  const detail = await work()
  const wall = performance.now() - start
  clearInterval(timer)
  rows.push([name, `${wall.toFixed(0)}ms`, `${worst.toFixed(0)}ms`, detail])
}

const ctx = new Context()
const fiber = ctx.plugin(JsonlSessionPersistence, { root: join(scratch, 'sessions') })
for (let i = 0; i < 100 && ctx.get('sessionPersistence') === undefined; i++) await new Promise(resolve => setTimeout(resolve, 50))
const browser = createForeignBrowser(() => ctx.get('sessionPersistence'))

let sources = []
await measure('打开会话屏：来源探测', async () => {
  sources = await browser.listSources()
  return sources.map(source => source.agentId).join(' ')
})
const newest = new Map()
for (const source of sources) {
  await measure(`进入 ${source.agentId}：冷列出`, async () => {
    const listed = await browser.listSessions(source.agentId)
    newest.set(source.agentId, listed[0])
    return `${listed.length} 个会话`
  })
  await measure(`进入 ${source.agentId}：再次列出`, async () => `${(await browser.listSessions(source.agentId)).length} 个会话`)
}
for (const source of sources) {
  const row = newest.get(source.agentId)
  if (row === undefined) continue
  await measure(`导入 ${source.agentId} 最近一条`, async () => {
    const result = await browser.importSession(source.agentId, row.key)
    return result.kind === 'ready' ? '成功' : `${result.kind}${'reason' in result ? `:${result.reason}` : ''}`
  })
}
await Promise.resolve(fiber.dispose()).catch(() => {})
rmSync(scratch, { recursive: true, force: true })

const width = Math.max(...rows.map(row => row[0].length))
console.log(`${'项目'.padEnd(width)}  ${'耗时'.padStart(7)}  ${'最长停顿'.padStart(7)}  说明`)
for (const [name, wall, stall, detail] of rows) console.log(`${name.padEnd(width)}  ${wall.padStart(7)}  ${stall.padStart(7)}  ${detail}`)
