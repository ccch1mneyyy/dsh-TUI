/** Host-owned in-process Channel contract. No runtime or upstream imports. */


export interface LocalCommand {
  /** The command name without the slash, e.g. `clear`. */
  name: string
  /**
   * One-line description shown in the suggestion overlay — the English text
   * and the fallback for languages without a `cmd-desc-<name>` dict entry
   * (see {@link localizedDescription}).
   */
  description: string
  /** Provider-owned translations selected with the active TUI language. */
  descriptions?: LocalizedDescriptions
  /** Optional bracket tag shown between name and description. */
  tag?: string
  /** True when a DSH plugin registered this command (not built in). */
  external?: boolean
  /** True when this command explicitly accepts composer images. Local
   * commands default to false; registry entries mirror `input.images`. */
  acceptsImages?: boolean
  /**
   * True when the entry is a user-invocable skill discovered by the DSH
   * skill registry (issue #86). Skill entries are completion-only: dispatch
   * falls through to the model as plain text, where dsh-tool-skill's
   * pre-step hook injects the skill body — the same path a hand-typed
   * `/skill-name` takes. The help menu hides them (chrome commands only).
   */
  skill?: boolean
}

export type LocalizedDescriptions = Readonly<Partial<Record<'zh' | 'en', string>>>

/** A concrete completion row, including the text inserted by Tab/Enter. */
export interface CommandCompletion extends LocalCommand {
  replacement: string
  commandLine: string
  descriptionKey?: string
}

export type BalanceResult =
  | {
    readonly ok: true
    /** 账户是否可用（是否有可用额度）。 */
    readonly isAvailable: boolean
    readonly balances: readonly BalanceInfo[]
  }
  | {
    readonly ok: false
    /** 失败分类：无 key / 网络或超时 / 认证失败 / 非 2xx / 响应结构非法。 */
    readonly reason: 'no-key' | 'network' | 'unauthorized' | 'http' | 'invalid'
    /** 非 2xx 时的 HTTP 状态码（其余分类无）。 */
    readonly status?: number
  }

/**
 * DeepSeek 官方账户余额查询（`GET /user/balance`）。
 *
 * 纯函数模块：只负责"用 key 换余额"，密钥由调用方（channel 的 credentials
 * seam → 环境变量兜底）解析，绝不在此打印或持久化。查询接口本身是只读的，
 * 不消耗 API 额度（社区插件均按秒/分钟级轮询使用）。
 *
 * 响应结构（官方文档）：
 *   { "is_available": true, "balance_infos": [
 *       { "currency": "CNY", "total_balance": "110.00",
 *         "granted_balance": "10.00", "topped_up_balance": "100.00" } ] }
 * 余额字段是字符串数字；`granted` 为赠送余额，`topped_up` 为充值余额，
 * 扣费优先扣赠送余额。
 */

/** 单个币种的余额快照（元）。 */
export interface BalanceInfo {
  currency: string
  /** 总余额 = granted + toppedUp。 */
  total: number
  /** 赠送余额。 */
  granted: number
  /** 充值余额。 */
  toppedUp: number
}

export interface FileCandidate {
  id: string
  path: string
  displayPath: string
  name: string
  kind: FileCandidateKind
  score: number
}

export type FileCandidateKind = 'file' | 'directory'

/** Outcome of one recap call, as surfaced on the Channel. */
export interface RecapOutcome {
  /** The one-line summary, or null when the call failed. */
  summary: string | null
  /** Proposed session title, when the model offered one. */
  title?: string
  /** Human-readable failure reason (llm missing, stream error, …). */
  error?: string
}
