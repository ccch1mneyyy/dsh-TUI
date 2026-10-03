/**
 * 内核选择器的目录（launchpad「内核」入口；用户原话：「启动页先起 TUI 前端
 * 再拉内核，现在多内核了，想在启动页加一个选项选进哪个内核」）。
 *
 * 纯数据：Claude 的异步探测（claudeBackend.detect()，src/backends/claude/
 * backend.ts，返回 BackendDetection）由 Chat 侧拉取后**传入**——本模块零
 * import、同输入恒同输出，表驱动回归离线钉死每种组合。
 *
 * 三个消费面共用这里的派生值，口径必须一致，谁都不许自己拼串：
 *   ① 右下角内核区（Launchpad，名字 · 副标题 一行一个内核）；
 *   ② 内核选择器（KernelPicker，副标题走 ListItem 的第二行）；
 *   ③ Chat 的确认路径（读 selectable/current/reasonKey 决定提示还是重启）。
 */

/** 可切换的内核 id（= Config.backend 的取值域）。 */
export type KernelId = 'dsh' | 'claude'

/** chip 插值与通知共用的品牌名（「内核 · Claude」——品牌词不翻译）。 */
export function kernelDisplayName(id: string): string {
  return id === 'dsh' ? 'DSH' : id === 'claude' ? 'Claude' : id
}
/**
 * 内核行置灰的原因（i18n key）。
 *
 * - kernel-unavailable-not-installed / kernel-unavailable-auth-missing：
 *   探测**已经回来**、明确不可用；
 * - kernel-probing：探测**还没回来**。置灰是因为此刻不能选它，但绝不算
 *   「未安装」——把「还不知道」说成「没有」是撒谎（用户会以为自己的 CLI 丢了）。
 */
export type KernelUnavailableReason =
  | 'kernel-unavailable-not-installed'
  | 'kernel-unavailable-auth-missing'
  | 'kernel-probing'

/**
 * 产品前缀表：内核 id → 版本串的产品名。
 * 版本号本身（0.2.0-rc.2）不带产品名就没有身份，而产品名与内核 id 并不是
 * 同一个词（dsh → dsh-core、claude → claude-code），所以映射写在这里一份。
 */
const KERNEL_PRODUCT: Readonly<Record<string, string>> = {
  dsh: 'dsh-core',
  claude: 'claude-code',
}

/**
 * 内核版本**显示串**：dsh-core v0.2.0-rc.2 / claude-code v2.0.1。
 *
 * @param id - 内核 id（决定产品前缀）。
 * @param version - 原始版本号（探测/manifest 的读数）。
 * @returns 显示串；空串与缺省都返回 undefined（调用方据此整段省掉，绝不画
 *   一个空壳的 v）。未知 id 返回裸版本号——宁可少一个产品名，也不编造。
 */
export function kernelVersionLabel(id: string, version?: string): string | undefined {
  if (version === undefined || version === '') return undefined
  const product = KERNEL_PRODUCT[id]
  return product === undefined ? version : product + ' v' + version
}

/** 选择器的一行。 */
export interface KernelOption {
  readonly id: KernelId
  /** 行标签（i18n key）。 */
  readonly labelKey: string
  /** 本进程正在跑的内核（选择器标记当前项）。 */
  readonly current: boolean
  /** false = 置灰：选中只提示、绝不重启。 */
  readonly selectable: boolean
  /** 不可选原因（可选时缺席）。 */
  readonly reasonKey?: KernelUnavailableReason
  /** 版本**显示串**（kernelVersionLabel 生成：DSH = dsh-core，Claude = claude-code）；读不到 = 缺席。 */
  readonly version?: string
}

/** Chat 侧传入的 Claude 探测结果（BackendDetection 的结构子集；刻意不
 *  import 原类型，保持本模块零依赖）。 */
export interface ClaudeKernelStatus {
  readonly installed: boolean
  readonly auth?: 'ok' | 'missing' | 'unknown'
  readonly version?: string
}

/**
 * 选择器的目录行：DSH（恒可用——默认内核）在前、Claude 在后。
 *
 * Claude 的可选性三态：
 *   - **探测缺席**（claude === undefined，异步探测还没回来）→ 置灰，原因
 *     kernel-probing（「检测中…」），**不是**「未安装」；
 *   - 探测已回来：已安装且凭证不是明确缺失才可选；auth=unknown（平台钥匙串，
 *     分不清 ≠ 没有）保持可选，只有 installed=false 或 auth=missing 置灰。
 *
 * @param input - 当前内核 + 两级版本读数（缺失即不画那一段）。
 * @returns 恒两行的目录（选择器与右下角内核区同一份数据）。
 */
export function buildKernelCatalog(input: {
  /** 当前内核（channel.backendCapabilities.backendId）。 */
  readonly current: string
  /** DSH 的内核版本（installedKernelVersion()；读不到 = 无副标题）。 */
  readonly dshVersion?: string
  /** Claude 的探测结果（未探测 = 置灰为「检测中…」）。 */
  readonly claude?: ClaudeKernelStatus
}): readonly KernelOption[] {
  const claude = input.claude
  const claudeSelectable = claude !== undefined && claude.installed && claude.auth !== 'missing'
  const claudeReason: KernelUnavailableReason = claude === undefined
    ? 'kernel-probing'
    : claude.installed && claude.auth === 'missing'
      ? 'kernel-unavailable-auth-missing'
      : 'kernel-unavailable-not-installed'
  const dshVersion = kernelVersionLabel('dsh', input.dshVersion)
  const claudeVersion = kernelVersionLabel('claude', claude?.version)
  return [
    {
      id: 'dsh',
      labelKey: 'kernel-label-dsh',
      current: input.current === 'dsh',
      selectable: true,
      ...(dshVersion === undefined ? {} : { version: dshVersion }),
    },
    {
      id: 'claude',
      labelKey: 'kernel-label-claude',
      current: input.current === 'claude',
      selectable: claudeSelectable,
      ...(claudeSelectable ? {} : { reasonKey: claudeReason }),
      ...(claudeVersion === undefined ? {} : { version: claudeVersion }),
    },
  ]
}

/**
 * 内核行的副标题：版本 · 置灰原因——谁有拼谁（版本读不到就只剩原因，
 * 置灰原因没有就只剩版本），两样都没有 = undefined。
 *
 * 调用方据此决定画什么：右下角内核区是「名字 · 副标题」（副标题缺席就只画
 * 名字），选择器把副标题交给 ListItem 的第二行（undefined 时不占行）。
 *
 * @param option - 目录行。
 * @param reason - 原因 key → 文案（key => t(key)；本模块零 import，不自己查字典）。
 * @returns 副标题；两段都缺席时 undefined。
 */
export function kernelSubtitle(
  option: KernelOption,
  reason: (key: KernelUnavailableReason) => string,
): string | undefined {
  const parts: string[] = []
  if (option.version !== undefined && option.version !== '') parts.push(option.version)
  if (option.reasonKey !== undefined) parts.push(reason(option.reasonKey))
  return parts.length === 0 ? undefined : parts.join(' \u00b7 ')
}
