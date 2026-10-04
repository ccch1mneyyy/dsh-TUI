/**
 * Kernel-switch handoff ACK protocol — S05 完整版的第一半（deploy-transition
 * 设计 §S05 "完整版：launcher/supervisor 成为终端唯一 owner" 的进程内落点）。
 *
 * 在不引入独立 supervisor 进程的前提下（设计允许"可先由 profile bin 完整
 * 逻辑实现"），旧 TUI 进程承担 supervisor 角色，跨进程契约收缩为一条 ACK
 * 管道（fd 3）+ 两个屏幕状态字：
 *
 *   adopted  新实例挂上 AlternateScreen 时发出（它没有写 1049h——屏幕由
 *            旧父进程带过来，过场帧仍在 alt buffer 里）；
 *   ready    新实例**首帧 flush 后**发出——ready 的定义就是设计口径："新
 *            renderer 的第一帧 write 已由终端 owner flush/ack"，不是 root
 *            mount、不是进程存在、更不是 4 秒生存计时。
 *
 * 屏幕托管规则（"AltScreen 恰好闭合一次"）：
 *   - 旧父进程在整个尝试期间持有 1049 括号：进入是它自己 boot 时写的；
 *     切换时不写 1049l，过场帧写在 alt buffer 内；
 *   - 新实例 adopted 后到 ready 前**不写** 1049h/l（退出清理跳过——失败
 *     时由旧父进程收口）；ready ACK 写出成功的那一刻所有权移交；
 *   - 新实例正常退出（用户会话结束）时由它写 1049l，全链路恰好一次。
 *
 * 父进程侧的读取/分类在 src/update.ts（restartTui）；本模块只承载子进程
 * 侧的状态机，纯同步、可注入、无终端 I/O（ACK 走 writeSync 到给定 fd）。
 */
import { writeSync } from 'node:fs'

/** env：ACK 管道的 fd 号（旧父进程 spawn 时以 stdio[3]='pipe' 提供）。 */
export const HANDOFF_ACK_FD_ENV = 'DSH_TUI_HANDOFF_ACK_FD'
/** env：'alt'＝终端已由前任保持在 alternate screen（交接采用屏幕）。 */
export const HANDOFF_SCREEN_ENV = 'DSH_TUI_HANDOFF_SCREEN'
/** env：本次交接的 attemptId（restart.log 与过场事件共享词表）。 */
export const HANDOFF_ATTEMPT_ENV = 'DSH_TUI_HANDOFF_ATTEMPT'

/** ACK 行格式：dsh-tui-handoff <kind> <attemptId>。 */
export const ACK_PREFIX = 'dsh-tui-handoff'

export type HandoffAckKind = 'adopted' | 'ready'

export type HandoffAckState = {
  attemptId: string
  fd: number
  /**
   * 'armed'＝已收到 env 但还没挂上屏幕；'adopted'＝AlternateScreen 已挂接
   * （此后到 ready 前不写 1049l）；'ready'＝首帧已 flush 且 ACK 送达，
   * 1049 括号所有权移交本进程。
   */
  adoption: 'armed' | 'adopted' | 'ready'
  /** ACK 管道已不可写（父进程先亡等）：停止尝试，绝不误判已移交。 */
  dead: boolean
}

let state: HandoffAckState | undefined

/** 父进程是否为本进程武装了交接协议（boot 早期消费，一次性删除 env）。 */
export function beginHandoffAck(env: NodeJS.ProcessEnv = process.env): HandoffAckState | undefined {
  if (state !== undefined) return state
  const fdRaw = env[HANDOFF_ACK_FD_ENV]
  const attemptId = typeof env[HANDOFF_ATTEMPT_ENV] === 'string' ? env[HANDOFF_ATTEMPT_ENV]! : ''
  // 消费即删：host recompose、本进程再 spawn 的孩子都不能读到陈旧标记。
  delete env[HANDOFF_ACK_FD_ENV]
  delete env[HANDOFF_SCREEN_ENV]
  delete env[HANDOFF_ATTEMPT_ENV]
  if (fdRaw === undefined) return undefined
  const fd = Number(fdRaw)
  if (!Number.isInteger(fd) || fd < 0) return undefined
  state = { attemptId, fd, adoption: 'armed', dead: false }
  return state
}

/** 协议是否武装（供 AlternateScreen/render 装配查询；不消费 env）。 */
export function handoffAckArmed(): boolean {
  return state !== undefined
}

/** 武装的 attemptId（未武装＝undefined；事件日志共享词表用）。 */
export function handoffAttemptId(): string | undefined {
  return state?.attemptId === '' ? undefined : state?.attemptId
}

function sendAck(kind: HandoffAckKind): void {
  if (state === undefined || state.dead) return
  try {
    writeSync(state.fd, ACK_PREFIX + ' ' + kind + ' ' + state.attemptId + '\n')
  } catch {
    // 管道先亡：ACK 无法送达≠协议失败——保持未移交状态，让父进程的
    // close-without-ready 分支收口屏幕；本进程绝不在这种状态下自写 1049l。
    state.dead = true
  }
}

/**
 * 屏幕已被挂接（AlternateScreen 的 adoption 写落地后调用）：发 adopted、
 * 记录状态。此后到 ready 之前，本进程的退出清理不写 1049l。
 */
export function noteScreenAdopted(): void {
  if (state === undefined || state.adoption !== 'armed') return
  sendAck('adopted')
  if (!state.dead) state.adoption = 'adopted'
}

/**
 * 首帧已 flush：发 ready 并移交 1049 括号所有权。只应成功发送一次。
 */
export function markScreenReady(): void {
  if (state === undefined || state.adoption !== 'adopted') return
  sendAck('ready')
  // writeSync 失败会把 state.dead 置位——此时所有权**不**移交（父进程
  // 会在 close-without-ready 收口），本进程退出也不写 1049l。
  if (!state.dead) state.adoption = 'ready'
}

/**
 * 本进程此刻是否拥有 alt-screen 的退出写入权。未武装＝普通进程（恒真）；
 * 武装且未 ready＝旧父进程持有括号（跳过 1049l）；ready 或管道亡＝本进程
 * 自收口（后者是父进程已不在的兜底，宁可多一次也不留在 alt buffer 里）。
 */
export function ownsAltScreenExit(): boolean {
  if (state === undefined) return true
  return state.adoption === 'ready' || state.dead
}

/**
 * 在 stdout 上观察首帧：adoption 之后的第一次 write 的 flush 回调触发
 * markScreenReady。补丁一次性自恢复（恢复动作先于回调链，重入安全），
 * 未武装或未 adopted 时是 no-op——普通启动零开销。
 */
export function armFirstFrameAck(stdout: NodeJS.WriteStream): void {
  if (state === undefined || state.adoption !== 'armed' || state.dead) return
  const original = stdout.write as (...args: unknown[]) => boolean
  type Callback = (error?: Error | null) => void
  const wrapper = function (this: NodeJS.WriteStream, ...args: unknown[]) {
    const adopted = state !== undefined && state.adoption === 'adopted'
    if (!adopted) {
      // 屏幕还没挂接：这次写入不是 UI 帧（probe/清理等），原样放行，
      // 补丁继续等（不恢复、不计数）。
      return original.apply(stdout, args)
    }
    // 先恢复原实现：回调链与本帧之后的任何写入都走原路径。
    try {
      stdout.write = original as typeof stdout.write
    } catch {
      // 只读/被冻结的 stream——退化为立即 ready。
    }
    const userCallback: Callback | undefined = typeof args[1] === 'function' ? args[1] as Callback : typeof args[2] === 'function' ? args[2] as Callback : undefined
    const chained: Callback = error => {
      markScreenReady()
      if (userCallback !== undefined) userCallback(error)
    }
    if (typeof args[1] === 'string') return original.call(stdout, args[0], args[1], chained)
    if (userCallback === undefined) return original.call(stdout, args[0], chained)
    return original.call(stdout, args[0], chained)
  }
  try {
    stdout.write = wrapper as unknown as typeof stdout.write
  } catch {
    // 无法打补丁的流：无法观察 flush，直接按已 ready 处理（进程存在＋
    // UI 已挂接仍优于 4 秒计时——但记录不到 flush 事实，保守移交）。
    state.dead = true
    state.adoption = 'ready'
  }
}

/**
 * 解析 ACK 管道的一行（父进程侧，注入 update.ts 的 spawn 读取循环）。
 * 返回 null＝非协议行（忽略，不误判）。
 */
export function parseHandoffAckLine(line: string): { kind: HandoffAckKind; attemptId: string } | null {
  const match = new RegExp('^' + ACK_PREFIX + ' (adopted|ready) (.*)$').exec(line.trim())
  if (match === null) return null
  return { kind: match[1] as HandoffAckKind, attemptId: match[2] }
}

/** 测试注入：直接装配一个状态（不读 env、不写 fd）。 */
export function __setHandoffAckStateForTest(next: HandoffAckState | undefined): void {
  state = next
}
