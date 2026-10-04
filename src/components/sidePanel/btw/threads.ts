/**
 * btw 线程 store（设计 btw-panel.md §线程状态）：sideQuery 的问答线程是
 * 纯 UI 暂态——按 session id 隔离、仅内存、进程重启即清空，绝不写主
 * session record（DSH SessionEvent / Claude JSONL 一概不碰）。每次追问
 * 显式携带最近 N 组完成问答（字符预算有界，按完整轮次从最旧裁剪），
 * 新话题清线程并 abort 在途回路。
 *
 * 合同保全（capabilities.ts sideQuery：一次无工具单答案旁路调用）：
 * - submit 只经调用方注入的 ask（= channel.sideQuestion）发起**一次**
 *   调用，prompt 由 sideThreadQuestion 拼好整段作为 question 传入——
 *   两个后端的单问包装合同逐字节不变；
 * - 本模块不 import 任何后端，也没有 submit/steer/pushLocal 一类主
 *   会话写入口，结构上写不了转录。
 *
 * 竞态与并发：每线程最多一条 in-flight ask（busy 拒绝，不隐式取消）；
 * 全局并发上限 2（跨 session 的旧线程在切换后仍可流完）。代际守卫：
 * 每次写回前核对 thread generation 与 turn phase——新话题清线程或
 * abort 之后迟到的 onText/result 一律丢弃。
 */
import { sideThreadQuestion, type SideThreadPriorTurn } from '../../../channel/side-prompts.js'
import { t } from '../../../i18n.js'

export type BtwTurnPhase = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface BtwTurn {
  readonly turnId: string
  /** 全局单调序（unread 的 seen-through 标尺）。 */
  readonly seq: number
  readonly question: string
  readonly answer: string
  readonly phase: BtwTurnPhase
  readonly error?: string
  readonly startedAt?: number
  readonly finishedAt?: number
  /** 本次 ask 实际携带的上下文轮次（最近 N 且在预算内）。 */
  readonly includedContextTurnIds: readonly string[]
  /** 超出 N/字符预算被裁掉的更早完成轮数（UI 显示 omitted count）。 */
  readonly omittedOlderCount: number
}

export interface BtwThreadSnapshot {
  readonly sessionId: string
  readonly threadId: string
  readonly createdAt: number
  readonly generation: number
  readonly turns: readonly BtwTurn[]
  readonly activeTurnId: string | null
  readonly draft: string
  /** seen-through 标尺之后的完成/失败轮（cancelled 不计：用户自己中止，
   * 不是没看到的新答案）。 */
  readonly unread: { readonly count: number; readonly error: boolean }
  readonly version: number
}

/** 最近 N 组问答：默认 4，可配范围 1–8（normalize 钳制）。 */
export const BTW_RECENT_TURNS_DEFAULT = 4
export const BTW_RECENT_TURNS_MIN = 1
export const BTW_RECENT_TURNS_MAX = 8
/** 线程上下文总字符预算（问题+裁剪后答案）。 */
export const BTW_CONTEXT_CHAR_BUDGET = 24_000
/** 单条答案进入上下文时的裁剪上限。 */
export const BTW_ANSWER_CHAR_BUDGET = 8_000
/** 跨线程并发上限：超过显示忙，不隐式取消。 */
export const BTW_MAX_CONCURRENT_ASKS = 2

/** submit 的 ask 门面 = channel.sideQuestion（一次无工具单答案旁路）。 */
export type BtwAskFacade = (
  question: string,
  options?: { readonly signal?: AbortSignal; readonly onText?: (delta: string) => void },
) => Promise<{ readonly answer: string | null; readonly error?: string }>

export type BtwSubmitResult =
  | { readonly ok: true; readonly turnId: string }
  | { readonly ok: false; readonly reason: 'empty' | 'busy' | 'congested' }

/** 钳到 1–8；非有限值取默认 4。 */
export function normalizeRecentTurnsLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return BTW_RECENT_TURNS_DEFAULT
  return Math.min(BTW_RECENT_TURNS_MAX, Math.max(BTW_RECENT_TURNS_MIN, Math.round(value)))
}

/** 按字符预算从尾部裁（不撕裂代理对；与 sideQuestion.ts 的 clip 同语义）。 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const code = text.charCodeAt(limit - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
  return `${text.slice(0, end)}…`
}

export interface BtwContextSelection {
  /** 参与下一次 ask 的完成轮（旧→新）。 */
  readonly included: readonly BtwTurn[]
  readonly omittedOlderCount: number
}

/**
 * 选出下一次 ask 携带的上下文：先取最近 N 组**完成**轮，再按字符预算
 * （单答案 8k 裁剪后计入、总计 24k）从最旧开始整轮丢弃；被丢的轮数
 * （窗口外 + 超预算）汇成 omittedOlderCount。纯函数。
 */
export function selectContextTurns(
  turns: readonly BtwTurn[],
  limit: number = BTW_RECENT_TURNS_DEFAULT,
  budgets: { readonly total?: number; readonly perAnswer?: number } = {},
): BtwContextSelection {
  const window = normalizeRecentTurnsLimit(limit)
  const total = budgets.total ?? BTW_CONTEXT_CHAR_BUDGET
  // 单答预算内部派生（设置裁定：用户心智一个总量键就够）：默认 8k，
  // 但永远不超过总量的一半——一个收紧的总量不该被单答上限架空。
  const perAnswer = budgets.perAnswer ?? Math.min(BTW_ANSWER_CHAR_BUDGET, Math.floor(total / 2))
  const completed = turns.filter(turn => turn.phase === 'completed')
  if (completed.length === 0) return { included: [], omittedOlderCount: 0 }
  const recent = completed.slice(-window)
  const accepted: BtwTurn[] = []
  let used = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index]!
    const clippedAnswer = clip(turn.answer, perAnswer)
    const size = turn.question.length + clippedAnswer.length
    if (accepted.length > 0 && used + size > total) break
    accepted.unshift({ ...turn, answer: clippedAnswer })
    used += size
  }
  return { included: accepted, omittedOlderCount: completed.length - accepted.length }
}

/** DSH 空答案的字面错误映射成本地化文案（Claude 侧已有 i18n 键）。 */
function presentableError(error: string): string {
  return error === 'No response received' ? t('btw-output-unavailable') : error
}

interface ThreadRecord {
  readonly sessionId: string
  threadId: string
  createdAt: number
  generation: number
  turns: BtwTurn[]
  draft: string
  seenThroughSeq: number
  version: number
  snapshot: BtwThreadSnapshot
}

function buildSnapshot(record: ThreadRecord): BtwThreadSnapshot {
  const active = record.turns.find(turn => turn.phase === 'queued' || turn.phase === 'running') ?? null
  let unreadCount = 0
  let unreadError = false
  for (const turn of record.turns) {
    if (turn.seq <= record.seenThroughSeq) continue
    if (turn.phase === 'completed') unreadCount += 1
    else if (turn.phase === 'failed') { unreadCount += 1; unreadError = true }
  }
  return Object.freeze({
    sessionId: record.sessionId,
    threadId: record.threadId,
    createdAt: record.createdAt,
    generation: record.generation,
    turns: Object.freeze([...record.turns]),
    activeTurnId: active === null ? null : active.turnId,
    draft: record.draft,
    unread: Object.freeze({ count: unreadCount, error: unreadError }),
    version: record.version,
  })
}

class BtwThreadStore {
  private threads = new Map<string, ThreadRecord>()
  private controllers = new Map<string, AbortController>()
  private listeners = new Set<() => void>()
  private turnSeq = 0
  private threadSeq = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 当前 session 的线程快照（缺失 = 无线程；快照在两次更新间恒等）。 */
  get(sessionId: string): BtwThreadSnapshot | undefined {
    return this.threads.get(sessionId)?.snapshot
  }

  /**
   * 发起一轮追问：拼好线程上下文作为 question 整段交给 ask（一次
   * sideQuery 调用），流式增量与落定都经代际/相位守卫写回。同线程
   * 在途时 busy 拒绝；全局并发超上限 congested 拒绝（都不隐式取消）。
   */
  submit(
    sessionId: string,
    question: string,
    ask: BtwAskFacade,
    opts?: { readonly recentTurnsLimit?: number; readonly contextBudget?: number },
  ): BtwSubmitResult {
    const trimmed = question.trim()
    if (trimmed === '') return { ok: false, reason: 'empty' }
    const record = this.recordOf(sessionId)
    if (record.turns.some(turn => turn.phase === 'queued' || turn.phase === 'running')) {
      return { ok: false, reason: 'busy' }
    }
    let runningElsewhere = 0
    for (const other of this.threads.values()) {
      if (other === record) continue
      if (other.turns.some(turn => turn.phase === 'queued' || turn.phase === 'running')) runningElsewhere += 1
    }
    if (runningElsewhere >= BTW_MAX_CONCURRENT_ASKS) return { ok: false, reason: 'congested' }

    const selection = selectContextTurns(record.turns, opts?.recentTurnsLimit, {
      ...(opts?.contextBudget === undefined ? {} : { total: opts.contextBudget }),
    })
    const seq = ++this.turnSeq
    const turn: BtwTurn = {
      turnId: `btw-${seq}`,
      seq,
      question: trimmed,
      answer: '',
      phase: 'running',
      startedAt: Date.now(),
      includedContextTurnIds: selection.included.map(prior => prior.turnId),
      omittedOlderCount: selection.omittedOlderCount,
    }
    record.turns.push(turn)
    this.bump(record)

    const controller = new AbortController()
    this.controllers.set(turn.turnId, controller)
    const generation = record.generation
    const prompt = sideThreadQuestion(
      trimmed,
      selection.included.map((prior): SideThreadPriorTurn => ({ question: prior.question, answer: prior.answer })),
      selection.omittedOlderCount,
    )
    const settle = (write: (existing: BtwTurn) => BtwTurn): void => {
      const current = this.threads.get(sessionId)
      if (current === undefined || current.generation !== generation) return
      const index = current.turns.findIndex(candidate => candidate.turnId === turn.turnId)
      if (index < 0) return
      const existing = current.turns[index]!
      if (existing.phase !== 'running') return
      current.turns[index] = write({ ...existing, finishedAt: Date.now() })
      this.bump(current)
    }
    ask(prompt, {
      signal: controller.signal,
      onText: delta => {
        const current = this.threads.get(sessionId)
        if (current === undefined || current.generation !== generation || controller.signal.aborted) return
        const index = current.turns.findIndex(candidate => candidate.turnId === turn.turnId)
        if (index < 0) return
        const existing = current.turns[index]!
        if (existing.phase !== 'running') return
        current.turns[index] = { ...existing, answer: existing.answer + delta }
        this.bump(current)
      },
    }).then(result => {
      this.controllers.delete(turn.turnId)
      settle(existing => {
        if (controller.signal.aborted) return { ...existing, phase: 'cancelled' }
        if (result.answer !== null) return { ...existing, answer: result.answer, phase: 'completed' }
        if (result.error !== undefined) return { ...existing, error: presentableError(result.error), phase: 'failed' }
        return { ...existing, phase: 'cancelled' }
      })
    }, error => {
      this.controllers.delete(turn.turnId)
      settle(existing => ({
        ...existing,
        error: presentableError(error instanceof Error ? error.message : String(error)),
        phase: 'failed',
      }))
    })
    return { ok: true, turnId: turn.turnId }
  }

  /** 中止在途追问（相位立即转 cancelled；迟到的流/结果被守卫丢弃）。 */
  abortActive(sessionId: string): boolean {
    const record = this.threads.get(sessionId)
    if (record === undefined) return false
    const active = record.turns.find(turn => turn.phase === 'queued' || turn.phase === 'running')
    if (active === undefined) return false
    const index = record.turns.indexOf(active)
    record.turns[index] = { ...active, phase: 'cancelled', finishedAt: Date.now() }
    this.bump(record)
    this.controllers.get(active.turnId)?.abort()
    this.controllers.delete(active.turnId)
    return true
  }

  /**
   * 新话题：abort 在途、清 turns/draft/unread、换 thread id、generation+1。
   * 不影响其它 session 的线程，也不触发任何持久化。
   */
  newTopic(sessionId: string): boolean {
    const record = this.threads.get(sessionId)
    if (record === undefined) return false
    this.abortActive(sessionId)
    record.threadId = `btw-thread-${++this.threadSeq}-${Date.now().toString(36)}`
    record.createdAt = Date.now()
    record.generation += 1
    record.turns = []
    record.draft = ''
    record.seenThroughSeq = this.turnSeq
    this.bump(record)
    return true
  }

  setDraft(sessionId: string, text: string): void {
    const record = this.recordOf(sessionId)
    if (record.draft === text) return
    record.draft = text
    this.bump(record)
  }

  /** 看到最新线程：把已落定轮全部记为已读（running 轮落定时再见分晓）。 */
  markSeen(sessionId: string): void {
    const record = this.threads.get(sessionId)
    if (record === undefined) return
    const newestSettled = record.turns.reduce(
      (max, turn) => turn.phase === 'completed' || turn.phase === 'failed' ? Math.max(max, turn.seq) : max,
      record.seenThroughSeq,
    )
    if (newestSettled === record.seenThroughSeq) return
    record.seenThroughSeq = newestSettled
    this.bump(record)
  }

  /** 显式丢弃某 session 的内存线程（切换时的最小档；默认保留作完整档）。 */
  forget(sessionId: string): void {
    this.abortActive(sessionId)
    this.threads.delete(sessionId)
    this.emit()
  }

  /** 测试/多夹具隔离用：清空全部线程状态。 */
  resetForTest(): void {
    for (const record of this.threads.values()) this.abortActive(record.sessionId)
    this.threads.clear()
    this.emit()
  }

  private recordOf(sessionId: string): ThreadRecord {
    let record = this.threads.get(sessionId)
    if (record === undefined) {
      record = {
        sessionId,
        threadId: `btw-thread-${++this.threadSeq}-${Date.now().toString(36)}`,
        createdAt: Date.now(),
        generation: 0,
        turns: [],
        draft: '',
        seenThroughSeq: this.turnSeq,
        version: 0,
        snapshot: Object.freeze({
          sessionId,
          threadId: '',
          createdAt: 0,
          generation: 0,
          turns: Object.freeze([]),
          activeTurnId: null,
          draft: '',
          unread: Object.freeze({ count: 0, error: false }),
          version: 0,
        }) as BtwThreadSnapshot,
      }
      record.snapshot = buildSnapshot(record)
      this.threads.set(sessionId, record)
    }
    return record
  }

  private bump(record: ThreadRecord): void {
    record.version += 1
    record.snapshot = buildSnapshot(record)
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** 进程级单例（与 jobsFocusStore 同款挂法）。 */
export const btwThreads = new BtwThreadStore()
