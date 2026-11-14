import { t } from '../../i18n.js'
import type { ChannelState } from './types.js'

/** The kernel owns this guard and the terminals. Only explain its refusal;
 * never close a shell or retry a policy mutation as a reporting side effect. */
export function reportPersistentTerminalModeFailure(
  message: string,
  pushLocal?: ChannelState['pushLocal'],
): string | undefined {
  if (!/^cannot change sandbox mode from "[^"\r\n]+" to "[^"\r\n]+" while persistent terminal sessions are open or being created; wait for creation to settle and close them first$/u.test(message)) return undefined
  const summary = t('mode-terminal-blocked')
  pushLocal?.(summary, [t('mode-terminal-blocked-reason'), t('mode-terminal-blocked-recovery')], { lineLimit: 1024 })
  return summary
}
