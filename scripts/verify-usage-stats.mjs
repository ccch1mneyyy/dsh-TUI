/**
 * 本机用量统计与求 star 里程碑（`src/usageStats.ts`）的回归。
 *
 * 钉死三件事：
 *   ① 账本文件缺失/损坏/字段类型不对 → 一律当 0，且**绝不抛错**（开屏不能被统计搞挂）；
 *   ② 一次进程只记一次启动（`recordLaunch` 重复调用不重复 +1），写盘是"临时文件 + 改名"；
 *   ③ 里程碑阶梯：跨档只报最高那档、报过的不再报、全报完返回 null。
 *
 * 运行：node --import tsx/esm scripts/verify-usage-stats.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { EMPTY_USAGE, STAR_MILESTONES, isHistoricMilestone, markStarAsked, pendingStarMilestone, readUsage, recordLaunch, writeUsage } =
  await import('../src/usageStats.js')

let checks = 0
const failures = []
const check = (name, condition, detail = '') => {
  checks++
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === '' ? '' : `  (${detail})`}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-usage-'))
const hour = 3_600_000

// ── ① 读：缺失、损坏、类型不对都当 0 ──────────────────────────────────────
check('文件不存在 → 空账本', JSON.stringify(readUsage(root)) === JSON.stringify(EMPTY_USAGE))
writeFileSync(join(root, 'usage.json'), '{ 这不是 JSON')
check('损坏文件 → 空账本（不抛错）', JSON.stringify(readUsage(root)) === JSON.stringify(EMPTY_USAGE))
writeFileSync(join(root, 'usage.json'), JSON.stringify({ launches: -3, totalMs: 'x', celebrated: null }))
check('字段类型不对 → 逐项归零', JSON.stringify(readUsage(root)) === JSON.stringify(EMPTY_USAGE))
writeFileSync(join(root, 'usage.json'), JSON.stringify([1, 2, 3]))
check('顶层是数组 → 空账本', JSON.stringify(readUsage(root)) === JSON.stringify(EMPTY_USAGE))

// ── ② 写 + 记启动 ────────────────────────────────────────────────────────
check('写盘往返', writeUsage({ launches: 7, totalMs: 3 * hour, celebrated: 2 }, root) && readUsage(root).launches === 7)
check('写盘不留 .tmp', (() => {
  try {
    readFileSync(join(root, 'usage.json.tmp'), 'utf8')
    return false
  } catch {
    return true
  }
})())

const first = recordLaunch(root)
const second = recordLaunch(root)
check('recordLaunch：次数 +1 并落盘', first.launches === 8 && readUsage(root).launches === 8, `${first.launches}`)
check('recordLaunch：同进程重复调用不再 +1', second.launches === 8, `${second.launches}`)

// ── ③ 里程碑阶梯 ─────────────────────────────────────────────────────────
const at = stats => ({ launches: 0, totalMs: 0, celebrated: 0, ...stats })
check('什么都没到 → null', pendingStarMilestone(at({ launches: 99, totalMs: 23 * hour })) === null)
check('刚到 24h → 第 0 档', pendingStarMilestone(at({ totalMs: 24 * hour })) === 0)
check('99h → 第 2 档', pendingStarMilestone(at({ totalMs: 99 * hour })) === 2)
check('第 100 次 → 第 3 档（比 99h 高）', pendingStarMilestone(at({ launches: 100, totalMs: 99 * hour })) === 3)
check('200h → 第 4 档', pendingStarMilestone(at({ totalMs: 200 * hour })) === 4)
check('10000 次 → 最后一档', pendingStarMilestone(at({ launches: 10_000 })) === STAR_MILESTONES.length - 1)
check(
  '999 次那一档就在阶梯里（不是 1000）',
  STAR_MILESTONES.some(milestone => milestone.launches === 999) &&
    !STAR_MILESTONES.some(milestone => milestone.launches === 1000),
)
const modalIndexes = STAR_MILESTONES.map((milestone, index) => (milestone.modal === true ? index : -1)).filter(
  index => index >= 0,
)
check(
  '24h、99h 与 999 次配弹窗（其余档绝不拦路）',
  modalIndexes.length === 3 &&
    STAR_MILESTONES[modalIndexes[0]].hours === 24 &&
    STAR_MILESTONES[modalIndexes[1]].hours === 99 &&
    STAR_MILESTONES[modalIndexes[2]].launches === 999 &&
    modalIndexes.every(index => isHistoricMilestone(index)) &&
    !isHistoricMilestone(1),
  `弹窗档位下标 ${modalIndexes.join('、')}`,
)
check('报过第 0 档后不再报它（下一档未达 → null）', pendingStarMilestone(at({ totalMs: 30 * hour, celebrated: 1 })) === null)
check('报过第 0 档后，跨到 50h 才报第 1 档', pendingStarMilestone(at({ totalMs: 50 * hour, celebrated: 1 })) === 1)
check('一次跨多档只报最高那档', pendingStarMilestone(at({ totalMs: 600 * hour, launches: 9999 })) === 8)
check('全报完 → null', pendingStarMilestone(at({ launches: 99_999, totalMs: 9999 * hour, celebrated: STAR_MILESTONES.length })) === null)

const markRoot = mkdtempSync(join(tmpdir(), 'dsh-usage-mark-'))
markStarAsked(0, markRoot)
check('markStarAsked 记进文件', readUsage(markRoot).celebrated === 1, `${readUsage(markRoot).celebrated}`)
markStarAsked(0, markRoot)
check('markStarAsked 幂等（不会回退）', readUsage(markRoot).celebrated === 1)
rmSync(markRoot, { recursive: true, force: true })

// ── 收尾 ─────────────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true })
console.log(`\n本机用量统计：${checks - failures.length}/${checks} 通过`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exit(1)
}
assert.equal(failures.length, 0)
