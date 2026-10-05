import React from 'react'
import type { ChannelUi } from '../../adapter/ports/channel-ui.js'
import { buildKernelCatalog, type KernelStatus } from '../../components/kernelCatalog.js'
import { t } from '../../i18n.js'
import { KERNEL_IDS, type KernelBackendId } from '../../kernelPrefs.js'
import type { ChatOverlayAction } from '../chatOverlay.js'

export function useKernelPicker({ channel, kernelVersion, launchpadShown, onProbeKernels, onSwitchBackend, dispatchOverlay }: {
  channel: ChannelUi
  kernelVersion: string | undefined
  launchpadShown: boolean
  onProbeKernels: (() => Promise<Record<string, KernelStatus>>) | undefined
  onSwitchBackend: ((id: KernelBackendId) => void) | undefined
  dispatchOverlay: React.Dispatch<ChatOverlayAction>
}) {
  const currentId = channel.backendCapabilities?.backendId ?? 'dsh'
  const [probe, setProbe] = React.useState<Record<string, KernelStatus> | undefined>(undefined)
  const probeStarted = React.useRef(false)
  const requestProbe = React.useCallback((): void => {
    if (probeStarted.current || onProbeKernels === undefined) return
    probeStarted.current = true
    void onProbeKernels().then(setProbe).catch(() => {
      setProbe(Object.fromEntries(KERNEL_IDS.map(id => [id, { installed: false }])))
    })
  }, [onProbeKernels])
  const options = React.useMemo(() => buildKernelCatalog({
    current: currentId,
    ...(kernelVersion === undefined ? {} : { dshVersion: kernelVersion }),
    ...(probe === undefined ? {} : { statuses: probe }),
  }), [currentId, kernelVersion, probe])
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
      channel.notify(option.reasonKey === undefined ? t('kernel-switch-unavailable') : t(option.reasonKey), { color: 'warning' })
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
      channel.notify(t('kernel-switch-while-working'), { color: 'warning' })
      return
    }
    dispatchOverlay({ type: 'close' })
    onSwitchBackend(option.id)
  }
  return { currentId, options, open, pick }
}
