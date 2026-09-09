import React from 'react'
import * as ui from '../ui.js'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import type { TuiSceneDescriptor } from './scenes.js'

/** Renderer-only outlet. Component identity stays in the existing scene registry. */
export function createChannelSceneOutlet(current: () => TuiSceneDescriptor | undefined) {
  return (id: string, channel: ChannelUi): React.ReactNode => {
    const scene = current()
    if (scene?.id !== id) throw new Error(`Scene unavailable: ${id}`)
    return React.createElement(scene.component, {
      React, ui, channel, close: () => channel.closePluginScene(),
    })
  }
}
