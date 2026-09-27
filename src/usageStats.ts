/**
 * 本机使用统计（`~/.dsh-tui/usage.json`）：累计启动次数与累计在线时长，只服务
 * 开屏那句"里程碑求 star"。三条硬约束：
 *
 * 1. **绝不影响开屏**：文件缺失/损坏/字段类型不对一律当 0，读不到就重写；
 * 2. **一次进程只记一次**：`recordLaunch()` 有模块级闸门，LogoV2 反复挂载也只 +1；
 * 3. **崩溃不丢太多**：启动时记 `startedAt`，每 5 分钟兜底落盘一次，退出时再补最后一段
 *    （定时器 `unref()`，不拖着进程不退）。
 *
 * 里程碑是**一条有序阶梯**（次数与时长按"1 次 ≈ 1 小时"的体感交错），跨档时只报
 * 最高那一档，且每档只报一次——所以 `celebrated` 记的是"已报到第几档"。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

/** 兜底落盘间隔（毫秒）：被杀进程最多丢这么久。 */
const FLUSH_MS = 5 * 60 * 1000

/** 一档里程碑：次数或时长（小时）二者取一。 */
export interface StarMilestone {
  /** 累计启动次数门槛。 */
  readonly launches?: number
  /** 累计在线小时门槛。 */
  readonly hours?: number
}

/**
 * 求 star 的里程碑阶梯（有序）。次数档：100 / 500 / 1000 / 5000 / 10000；
 * 时长档：24 / 50 / 99 / 200 / 500 小时。两套按体感交错成一条线。
 */
export const STAR_MILESTONES: readonly StarMilestone[] = [
  { hours: 24 },
  { hours: 50 },
  { hours: 99 },
  { launches: 100 },
  { hours: 200 },
  { hours: 500 },
  { launches: 500 },
  { launches: 1000 },
  { launches: 5000 },
  { launches: 10000 },
]

/** 本机累计用量。 */
export interface UsageStats {
  /** 累计启动次数。 */
  readonly launches: number
  /** 累计在线毫秒。 */
  readonly totalMs: number
  /** 已报到第几档里程碑（`STAR_MILESTONES` 的下标 +1；0 = 从没报过）。 */
  readonly celebrated: number
}

/** 空账本（文件缺失/损坏时的回落）。 */
export const EMPTY_USAGE: UsageStats = { launches: 0, totalMs: 0, celebrated: 0 }

const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * 读取本机用量；任何异常与非法形状都回落成 0（开屏不许因为统计文件挂掉）。
 * @param dir - 数据目录（测试可注入）。
 * @returns 归一化后的用量。
 */
export function readUsage(dir: string = DATA_DIR): UsageStats {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_USAGE
    const raw = parsed as Record<string, unknown>
    return { launches: positive(raw.launches), totalMs: positive(raw.totalMs), celebrated: positive(raw.celebrated) }
  } catch {
    return EMPTY_USAGE
  }
}

/**
 * 写回本机用量（先写临时文件再改名，避免半截文件）。
 * @param stats - 要落盘的用量。
 * @param dir - 数据目录（测试可注入）。
 * @returns 是否写成功（失败只是不记账，不影响任何功能）。
 */
export function writeUsage(stats: UsageStats, dir: string = DATA_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'usage.json')
    const temp = `${target}.tmp`
    writeFileSync(temp, JSON.stringify(stats, null, 2))
    renameSync(temp, target)
    return true
  } catch {
    return false
  }
}

/** 一档里程碑是否已经达到。 */
const reached = (milestone: StarMilestone, stats: UsageStats): boolean =>
  (milestone.launches !== undefined && stats.launches >= milestone.launches) ||
  (milestone.hours !== undefined && stats.totalMs >= milestone.hours * 3_600_000)

/**
 * 该不该在这台机器上求一次 star，以及报到第几档。
 * @param stats - 当前用量。
 * @returns 未报过的、已达成的**最高**那一档的下标；没有则 `null`。
 */
export function pendingStarMilestone(stats: UsageStats): number | null {
  for (let index = STAR_MILESTONES.length - 1; index >= Math.max(0, stats.celebrated); index--) {
    if (reached(STAR_MILESTONES[index] as StarMilestone, stats)) return index
  }
  return null
}

/** 进程内闸门：一次进程、一个数据目录只记一次启动。 */
const recorded = new Set<string>()
/** 进程内缓存的账本（按目录分开存，生产只有一个目录；测试可注入不同目录）。 */
const caches = new Map<string, UsageStats>()
/** 本次进程开始计时的时刻（按目录）。 */
const startedAt = new Map<string, number>()

/** 把"本段时长"并进账本并落盘（幂等：`startedAt` 会被推进）。 */
const flush = (dir: string, extraIndex?: number): void => {
  const cached = caches.get(dir)
  if (cached === undefined) return
  const now = Date.now()
  const since = startedAt.get(dir) ?? now
  startedAt.set(dir, now)
  const next = {
    ...cached,
    totalMs: cached.totalMs + Math.max(0, now - since),
    celebrated: extraIndex === undefined ? cached.celebrated : extraIndex + 1,
  }
  caches.set(dir, next)
  writeUsage(next, dir)
}

/**
 * 记一次启动：累计次数 +1、开始计时，并挂上兜底落盘与退出补记。
 * 同一进程里对同一目录重复调用只生效一次（LogoV2 反复挂载也只 +1）。
 * @param dir - 数据目录（测试可注入）。
 * @returns 记完之后的用量（开屏拿它判里程碑）。
 */
export function recordLaunch(dir: string = DATA_DIR): UsageStats {
  const cached = caches.get(dir)
  if (recorded.has(dir) && cached !== undefined) return cached
  recorded.add(dir)
  startedAt.set(dir, Date.now())
  const previous = readUsage(dir)
  const next = { ...previous, launches: previous.launches + 1 }
  caches.set(dir, next)
  writeUsage(next, dir)

  const timer = setInterval(() => flush(dir), FLUSH_MS)
  // 定时器不拖着进程：TUI 退出时不该因为统计而多活 5 分钟。
  timer.unref?.()
  process.once('exit', () => flush(dir))
  return next
}

/**
 * 当前缓存的用量（没记过启动就是空账本）。
 * @param dir - 数据目录（测试可注入）。
 * @returns 该目录下的用量。
 */
export function usageSnapshot(dir: string = DATA_DIR): UsageStats {
  return caches.get(dir) ?? EMPTY_USAGE
}

/**
 * 把某一档标记为"已求过"（开屏决定显示之后调用一次）。
 * @param index - `STAR_MILESTONES` 的下标。
 * @param dir - 数据目录（测试可注入）。
 */
export function markStarAsked(index: number, dir: string = DATA_DIR): void {
  const cached = caches.get(dir) ?? readUsage(dir)
  const next = { ...cached, celebrated: Math.max(cached.celebrated, index + 1) }
  caches.set(dir, next)
  writeUsage(next, dir)
}
