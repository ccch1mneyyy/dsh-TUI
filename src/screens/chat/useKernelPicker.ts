import React from 'react'
import type { ChannelUi } from '../../adapter/ports/channel-ui.js'
import { buildKernelCatalog, type KernelEntry, type KernelStatus } from '../../components/kernelCatalog.js'
import { WORKING_GATE_NOTICES } from '../../commands.js'
import { t } from '../../i18n.js'
import type { KernelBackendId } from '../../kernelPrefs.js'
import type { ChatOverlayAction } from '../chatOverlay.js'

export function useKernelPicker({ channel, kernelVersion, kernelEntries, launchpadShown, onProbeKernels, onSwitchBackend, canInstallSdk, dispatchOverlay }: {
  channel: ChannelUi
  kernelVersion: string | undefined
  /** The host's registry projection, in picker order (P0: the UI renders the
   *  entry list it is handed and never imports the registry). */
  kernelEntries: readonly KernelEntry[]
  launchpadShown: boolean
  onProbeKernels: (() => Promise<Record<string, KernelStatus>>) | undefined
  onSwitchBackend: ((id: KernelBackendId) => void) | undefined
  /** The host wires the SDK install wizard (resolve target / start pnpm).
   *  Absent = no install path: the dim row keeps its dead-end reason. */
  canInstallSdk: boolean
  dispatchOverlay: React.Dispatch<ChatOverlayAction>
}) {
  const currentId = channel.backendCapabilities?.backendId ?? 'dsh'
  const [probe, setProbe] = React.useState<Record<string, KernelStatus> | undefined>(undefined)
  const probeStarted = React.useRef(false)
  const requestProbe = React.useCallback((): void => {
    if (probeStarted.current || onProbeKernels === undefined) return
    probeStarted.current = true
    void onProbeKernels().then(setProbe).catch(() => {
      // A failed probe leaves every optional backend "not installed" rather than
      // "checking" forever; dsh needs no status (it is always available).
      setProbe(Object.fromEntries(kernelEntries.map(entry => [entry.id, { installed: false }])))
    })
  }, [onProbeKernels, kernelEntries])
  /** Force a fresh probe (the once-guard stays for the automatic paths): the
   *  SDK install wizard calls this after a successful install so the dim
   *  row lights up without a process restart. */
  const reprobe = React.useCallback((): void => {
    probeStarted.current = false
    requestProbe()
  }, [requestProbe])
  const options = React.useMemo(() => buildKernelCatalog({
    current: currentId,
    entries: kernelEntries,
    ...(kernelVersion === undefined ? {} : { dshVersion: kernelVersion }),
    ...(probe === undefined ? {} : { statuses: probe }),
    canInstallSdk,
  }), [currentId, kernelEntries, kernelVersion, probe, canInstallSdk])
  React.useEffect(() => {
    if (launchpadShown) requestProbe()
  }, [launchpadShown, requestProbe])
  const currentIndex = Math.max(0, options.findIndex(option => option.current))
  const open = React.useCallback((index?: number): void => {
    requestProbe()
    dispatchOverlay({ type: 'open', overlay: { kind: 'kernel', index: index ?? currentIndex } })
  }, [currentIndex, requestProbe, dispatchOverlay])
  const pick = (index: number): void => {
    const option = options[index]
    if (option === undefined) return
    if (!option.selectable) {
      if (option.installable === true) {
        // The installable row opens the wizard instead of a dead-end toast;
        // the wizard owns its own keys (Enter/Esc) from here on. It carries the
        // row's id: the surface the wizard acts on is looked up per backend at
        // open time, not assumed (Stage B / §6 item 12).
        dispatchOverlay({ type: 'open', overlay: { kind: 'sdk-install', backendId: option.id } })
        return
      }
      // Detection's own guidance (how to install or upgrade) beats the bare reason.
      channel.notify(option.hint ?? (option.reasonKey === undefined ? t('kernel-switch-unavailable') : t(option.reasonKey)), { color: 'warning' })
      return
    }
    if (option.current) {
      dispatchOverlay({ type: 'close' })
      channel.notify(t('kernel-already-current'))
      return
    }
    if (onSwitchBackend === undefined) {
      channel.notify(t('kernel-switch-unavailable'), { color: 'warning' })
      return
    }
    if (channel.working) {
      channel.notify(t(WORKING_GATE_NOTICES.kernel), { color: 'warning' })
      return
    }
    dispatchOverlay({ type: 'close' })
    onSwitchBackend(option.id)
  }
  return { currentId, options, open, pick, reprobe }
}
