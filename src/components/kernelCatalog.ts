/** Kernel rows shared by the launchpad and picker. Detection is supplied by the host. */
import { KERNEL_IDS, KERNEL_INFO, isKernelId, type KernelBackendId } from '../kernelPrefs.js'
export { kernelDisplayName } from '../kernelPrefs.js'

export type KernelUnavailableReason =
  | 'kernel-unavailable-not-installed'
  | 'kernel-unavailable-auth-missing'
  | 'kernel-probing'
  /** The installable variant of not-installed: the row stays dim but Enter
   *  opens the SDK install wizard instead of a dead-end toast. */
  | 'kernel-not-installed-installable'

/** Product-qualified version; unknown kernels keep the raw version. */
export function kernelVersionLabel(id: string, version?: string): string | undefined {
  if (version === undefined || version === '') return undefined
  return isKernelId(id) ? KERNEL_INFO[id].product + ' v' + version : version
}

export interface KernelOption {
  readonly id: KernelBackendId
  readonly labelKey: string
  readonly current: boolean
  readonly selectable: boolean
  readonly reasonKey?: KernelUnavailableReason
  readonly version?: string
  /** Not installed, but the host can install it (Enter opens the wizard). */
  readonly installable?: boolean
}

export interface KernelStatus {
  readonly installed: boolean
  readonly auth?: 'ok' | 'missing' | 'unknown'
  readonly version?: string
}

/** DSH is always available. Optional kernels stay disabled until detection completes. */
export function buildKernelCatalog(input: {
  readonly current: string
  readonly dshVersion?: string
  readonly statuses?: Readonly<Record<string, KernelStatus>>
  /** The host provides an install path (the wizard callbacks): a dim
   *  not-installed row then says "press Enter to install" instead of a
   *  dead-end reason. */
  readonly canInstallSdk?: boolean
}): readonly KernelOption[] {
  return KERNEL_IDS.map(id => {
    const status = input.statuses?.[id]
    const selectable = id === 'dsh' || (status !== undefined && status.installed && status.auth !== 'missing')
    // `!selectable` already implies `id !== 'dsh'` (the DSH row is always
    // selectable), so an unselectable, undetected row is an install miss.
    const installable = !selectable && status !== undefined && !status.installed && input.canInstallSdk === true
    const reasonKey: KernelUnavailableReason = status === undefined
      ? 'kernel-probing'
      : installable
        ? 'kernel-not-installed-installable'
        : status.installed && status.auth === 'missing'
          ? 'kernel-unavailable-auth-missing'
          : 'kernel-unavailable-not-installed'
    const version = kernelVersionLabel(id, id === 'dsh' ? input.dshVersion : status?.version)
    return {
      id,
      labelKey: KERNEL_INFO[id].labelKey,
      current: input.current === id,
      selectable,
      ...(selectable ? {} : { reasonKey }),
      ...(installable ? { installable } : {}),
      ...(version === undefined ? {} : { version }),
    }
  })
}

/** Join the available version and unavailability reason without an empty subtitle. */
export function kernelSubtitle(
  option: KernelOption,
  reason: (key: KernelUnavailableReason) => string,
): string | undefined {
  const parts: string[] = []
  if (option.version !== undefined && option.version !== '') parts.push(option.version)
  if (option.reasonKey !== undefined) parts.push(reason(option.reasonKey))
  return parts.length === 0 ? undefined : parts.join(' \u00b7 ')
}
