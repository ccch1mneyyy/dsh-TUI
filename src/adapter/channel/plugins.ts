/**
 * Channel plugins module (P4 channel split).
 *
 * Projects the plugin-visible seams that hang off the live Channel into a
 * small host-internal Port: external plugin commands, plugin scenes and
 * settings sections. It never exposes plugin registration or permission
 * evaluation; those stay in Standard/Kernel.
 *
 * The internal `CHANNEL_SPLIT_TOKEN` is required so this split builder cannot
 * be invoked outside the Kernel/driver path and bypass the HostFacade shadow
 * gate.
 */

import type { Channel } from '../../dsh-adapter/channel.js'
import type { TuiSettingsSection } from '../../dsh-adapter/settings-sections.js'
import type {
  HostChannelPluginsPort,
  HostChannelSettingsSectionProjection,
} from '../ports/channel.js'
import { CHANNEL_SPLIT_TOKEN } from './internal-token.js'

function projectSettingsSection(section: TuiSettingsSection): HostChannelSettingsSectionProjection {
  return Object.freeze({
    ns: section.ns,
    title: section.title,
    ...(section.groups === undefined ? {} : {
      groups: Object.freeze(section.groups.map(group => Object.freeze({ id: group.id, title: group.title }))),
    }),
    fields: Object.freeze(section.fields.map(field => Object.freeze({
      path: Object.freeze([...field.path]),
      label: field.label,
      kind: field.kind,
      ...(field.hint === undefined ? {} : { hint: field.hint }),
      ...(field.group === undefined ? {} : { group: field.group }),
      ...(field.options === undefined ? {} : { options: Object.freeze(field.options.map(option => Object.freeze({ ...option }))) }),
      ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      ...(field.secret === undefined ? {} : { secret: Object.freeze({ ref: field.secret.ref }) }),
    }))),
  })
}

/** Build the host-internal plugin-facing surface over one live Channel. */
export function createChannelPlugins(channel: Channel, token: symbol): HostChannelPluginsPort {
  if (token !== CHANNEL_SPLIT_TOKEN) {
    throw new Error('dsh-tui: Channel split plugins require the internal host token')
  }
  return Object.freeze({
    async runExternalCommand(name: string, rawInput: string): Promise<string | undefined> {
      return channel.runExternalCommand(name, rawInput)
    },
    openPluginScene: id => channel.openPluginScene(id),
    closePluginScene: () => channel.closePluginScene(),
    settingsSections: () => Object.freeze(channel.settingsSections().map(projectSettingsSection)),
    subscribeSettingsSections: listener => channel.subscribeSettingsSections(listener),
  })
}
