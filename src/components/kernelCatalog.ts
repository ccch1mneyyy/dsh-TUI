/**
 * 内核选择器的目录（launchpad「内核」入口；用户原话：「启动页先起 TUI 前端
 * 再拉内核，现在多内核了，想在启动页加一个选项选进哪个内核」）。
 *
 * 纯数据：Claude 的异步探测（claudeBackend.detect()，src/backends/claude/
 * backend.ts，返回 BackendDetection）由 Chat 侧拉取后**传入**——本模块零
 * import、同输入恒同输出，表驱动回归离线钉死每种组合。
 */

/** 可切换的内核 id（= Config.backend 的取值域）。 */
export type KernelId = 'dsh' | 'claude'

/** chip 插值与通知共用的品牌名（「内核 · Claude」——品牌词不翻译）。 */
export function kernelDisplayName(id: string): string {
  return id === 'dsh' ? 'DSH' : id === 'claude' ? 'Claude' : id
}

/** 内核行置灰的原因（i18n key）。 */
export type KernelUnavailableReason = 'kernel-unavailable-not-installed' | 'kernel-unavailable-auth-missing'

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
  /** 版本副行：DSH = dsh-core（contract.installedKernelVersion），Claude = 探测到的 CLI 版本。 */
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
 * 选择器的目录行：DSH（恒可用——默认内核）在前、Claude 在后。Claude 仅在
 * 探测到已安装且凭证不是明确缺失时可选；auth=unknown（平台钥匙串，分不清
 * ≠没有）保持可选，只有 installed=false 或 auth=missing 置灰。
 */
export function buildKernelCatalog(input: {
  /** 当前内核（channel.backendCapabilities.backendId）。 */
  readonly current: string
  /** DSH 的内核版本（installedKernelVersion()；读不到 = 无副行）。 */
  readonly dshVersion?: string
  /** Claude 的探测结果（未探测 = 置灰为未安装）。 */
  readonly claude?: ClaudeKernelStatus
}): readonly KernelOption[] {
  const claude = input.claude
  const claudeSelectable = claude !== undefined && claude.installed && claude.auth !== 'missing'
  return [
    {
      id: 'dsh',
      labelKey: 'kernel-label-dsh',
      current: input.current === 'dsh',
      selectable: true,
      ...(input.dshVersion === undefined || input.dshVersion === '' ? {} : { version: input.dshVersion }),
    },
    {
      id: 'claude',
      labelKey: 'kernel-label-claude',
      current: input.current === 'claude',
      selectable: claudeSelectable,
      ...(claudeSelectable
        ? {}
        : { reasonKey: claude?.installed === true && claude.auth === 'missing' ? 'kernel-unavailable-auth-missing' : 'kernel-unavailable-not-installed' }),
      ...(claude?.version === undefined || claude.version === '' ? {} : { version: claude.version }),
    },
  ]
}
