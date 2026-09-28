/**
 * 求 star 的"一键"动作：`gh repo star <owner>/<repo>`。
 *
 * 为什么是 `gh` 而不是 `git`：star 是 GitHub 的 API 概念，`git` 本身没有这个能力；
 * 而且终端里的 OSC 8 链接**只能打开 URL**，点不出命令来——所以"一键"必须是 TUI 里
 * 一个显式动作（`/star` 或弹窗按钮），由用户按下去才执行。
 *
 * 三条硬约束：
 * 1. **绝不自动 star**：没有用户动作就不会调用这里；
 * 2. **绝不阻塞界面**：全部走 `execFileNoThrow`（永不 reject）+ 每步都有超时；
 * 3. **失败要说人话**：没装 `gh` / 没登录 / 网络失败分别给不同结论，调用方好回一句
 *    有意义的提示，并回落到"在浏览器里打开"。
 */

import { execFileNoThrow } from './utils/execFileNoThrow.js'

/** 要 star 的仓库（`owner/name`）。 */
export const STAR_REPO = 'ccch1mneyyy/dsh-TUI'

/** 一键 star 的结果：`starred` 以外都是"没成，但说清了为什么"。 */
export type StarOutcome =
  | { readonly kind: 'starred' }
  | { readonly kind: 'no-gh' }
  | { readonly kind: 'not-authed' }
  | { readonly kind: 'failed'; readonly detail: string }

/** 探测 `gh` 是否存在用的命令（只读，不改任何东西）。 */
const GH_VERSION_ARGS = ['--version'] as const
/** 判定登录态：`gh auth status` 退出码非 0 就是没登录。 */
const GH_AUTH_ARGS = ['auth', 'status'] as const
/**
 * 点 star 的本体：`gh api -X PUT user/starred/<owner>/<repo>`。**不用**
 * `gh repo star`——那是 gh ≥ 2.63 才有的子命令，老版本直接报
 * `unknown command "star" for "gh repo"`（本机实测踩坑）；REST PUT 全
 * 版本 gh 可用，成功即 204（gh api 对 204 打空 body、退出码 0）。
 */
const GH_STAR_ARGS = ['api', '-X', 'PUT', `user/starred/${STAR_REPO}`] as const

/** 执行器签名（测试注入用；生产就是 `execFileNoThrow`）。 */
export type StarExec = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** 把子进程输出压成一行短句（提示里不塞整段 stderr）。 */
const summarize = (result: { code: number | null; stdout: string; stderr: string }): string => {
  if (result.code === null) return '命令超时或被杀掉'
  const text = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).replace(/\s+/gu, ' ')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 让本机 `gh` 给仓库点一个 star。
 * @param options - `exec` 是测试缝；`timeoutMs` 是 star 那一步的超时（探测步骤固定短超时）。
 * @returns 结果；只有 `starred` 表示真的点上了。
 */
export async function starRepo(options?: { exec?: StarExec; timeoutMs?: number }): Promise<StarOutcome> {
  const exec = options?.exec ?? execFileNoThrow
  const probe = await exec('gh', GH_VERSION_ARGS, { timeout: 3000 })
  if (probe.code !== 0) return { kind: 'no-gh' }

  const auth = await exec('gh', GH_AUTH_ARGS, { timeout: 5000 })
  if (auth.code !== 0) return { kind: 'not-authed' }

  const star = await exec('gh', GH_STAR_ARGS, { timeout: options?.timeoutMs ?? 15_000 })
  if (star.code === 0) return { kind: 'starred' }
  return { kind: 'failed', detail: summarize(star) }
}
