/**
 * 内核选择器的记忆（~/.dsh-tui/kernel.json，形状 `{ "backend": "claude" }`）：
 * 上次在启动页选择器里选过的内核——只是下一次启动的便利默认，仅此而已。
 * 显式选择（`dsh-tui --backend`、Config 行、DSH_TUI_BACKEND）永远压过它；
 * boot 只读不写：唯一写入口是选择器的确认路径（显式 --backend 启动不改写
 * 记忆）。
 *
 * 与所有 ~/.dsh-tui 偏好同样 best-effort（见 Claude 后端 prefs.ts）：文件
 * 缺失或损坏读作「无记忆」；写入用同目录临时文件 + rename 的原子提交，并
 * 发读者永远只会看到旧文档或新文档、绝不会看到截断的半个。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

/** 可运行的内核（Config.backend 的取值域）。 */
export type KernelBackendId = 'dsh' | 'claude'

/** 持久化的内容。 */
export interface KernelPrefsData {
  readonly backend?: KernelBackendId
}

/** 收窄解析结果：只有合法 backend 值存活，其余一律读作无记忆。 */
function parseKernelPrefs(parsed: unknown): KernelPrefsData {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const backend = (parsed as Record<string, unknown>).backend
  return backend === 'dsh' || backend === 'claude' ? { backend } : {}
}

/** 读记忆；任何失败（缺失、损坏、不可读）= 无记忆，绝不抛。 */
export function readKernelPrefs(file: string = join(DATA_DIR, 'kernel.json')): KernelPrefsData {
  try {
    return parseKernelPrefs(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

/** 每次提交用一个未用过的临时名（prefs.ts 的 writePinsAtomic 模式）。 */
let temporarySequence = 0
/** Windows rename 重试的等待单元（prefs.ts 同款）。 */
const waitCell = new Int32Array(new SharedArrayBuffer(4))

/** 把同目录临时文件 rename 到目标上（prefs.ts 模式：Windows 的瞬时
 *  EPERM/EBUSY 短同步等待重试，其他拒绝立即抛出、旧文档保持原样）。 */
function renameIntoPlace(temporary: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, target)
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? String((error as NodeJS.ErrnoException).code) : ''
      if (process.platform !== 'win32' || attempt >= 7 || (code !== 'EPERM' && code !== 'EBUSY')) throw error
      Atomics.wait(waitCell, 0, 0, 2 ** attempt)
    }
  }
}

/** 原子持久化记忆（tmp + rename）；失败落 debug 日志，绝不抛。 */
export function writeKernelPrefs(
  data: KernelPrefsData,
  file: string = join(DATA_DIR, 'kernel.json'),
  debug: (message: string) => void = () => undefined,
): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameIntoPlace(temporary, file)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // 旧文档仍完好；别无安全的补救。
    }
    debug(`dsh-tui: kernel prefs write failed (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** 镜像 dsh-adapter 的 normalizeBackendChoice（刻意本地实现，本模块不背
 *  adapter 依赖）：大小写不敏感、去空白；空或未知 → undefined。 */
function normalizeBackend(value: string | undefined): KernelBackendId | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  return id === 'dsh' || id === 'claude' ? id : undefined
}

/**
 * boot 时的内核选择（plugin.ts 的 backendChoice）：显式 Config 行或
 * DSH_TUI_BACKEND 永远优先；其次选择器记忆；否则 dsh。**非法** env 值仍落
 * dsh——boot 警告原文就是 "starting on dsh"，不能让它掉到记忆上。纯函数：
 * 不读不写（记忆只被选择器的确认路径写，见 writeKernelPrefs 的注释）。
 */
export function resolveRememberedBackend(input: {
  /** Config.backend（schema 已归一）。 */
  readonly configured?: KernelBackendId | undefined
  /** process.env.DSH_TUI_BACKEND 原文。 */
  readonly envRaw?: string | undefined
  /** kernel.json 记住的内核。 */
  readonly memory?: KernelBackendId | undefined
}): KernelBackendId {
  if (input.configured === 'dsh' || input.configured === 'claude') return input.configured
  const env = normalizeBackend(input.envRaw)
  if (env !== undefined) return env
  if (input.envRaw !== undefined && input.envRaw.trim() !== '') return 'dsh'
  return input.memory ?? 'dsh'
}
