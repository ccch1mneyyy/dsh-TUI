/**
 * The one root every launch mounts: `ThemeProvider → [AlternateScreen →]
 * PageMargin → Chat`, driven by a small store (`BootSlot`) that says which
 * channel and host props Chat renders with right now.
 *
 * Both launch paths go through here. A plain `dsh-tui` launch mounts the slot
 * already live. The `dst` fast start mounts it BEFORE dsh runs, with a boot
 * channel (`bootChannel.ts`, `ready === false`) and inert host props, and the
 * plugin later calls `slot.ready(live)`: the deferred channel slides the live
 * channel underneath the same object, the props swap, and React updates the
 * mounted tree — no second screen, no re-mount, no state to hand over. The
 * composer keeps its text because it never unmounted.
 *
 * The renderer options an Ink instance cannot change after mount
 * (`terminalImages`) and the root wrap (`fullscreen`) are fixed per slot;
 * a host whose own resolution differs disposes the slot and mounts a fresh
 * one (see plugin.ts).
 */
import React from 'react'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import { createDeferredChannel } from '../adapter/channel/deferred.js'
import { PageMargin } from '../components/PageMargin.js'
import type { PromptController } from '../components/PromptInput.js'
import { Chat } from '../screens/Chat.js'
import { AlternateScreen, render, ThemeProvider, type Instance, type RenderOptions } from '../ui.js'

/** Everything Chat takes from its host except what the slot owns. */
export type ChatHostProps = Omit<React.ComponentProps<typeof Chat>, 'channel' | 'fullscreen' | 'promptControllerRef'>

/** The live channel and host props the plugin hands over once dsh is up. */
export interface LiveChat {
  readonly channel: ChannelUi
  readonly props: ChatHostProps
}

export type BootSlotPhase = 'booting' | 'ready' | 'disposed'

export interface BootSlot {
  /** The channel object Chat holds for its whole life (a deferred wrapper). */
  readonly channel: ChannelUi
  /** Root-wrap decision this slot was mounted with. */
  readonly fullscreen: boolean
  /** Ink instance option this slot was mounted with. */
  readonly terminalImages: boolean
  /** `performance.now()` when the slot mounted (diagnostics). */
  readonly mountedAt: number
  readonly phase: BootSlotPhase
  /** The Ink instance behind the tree (exit funnel, teardown). */
  readonly instance: Instance
  /**
   * Bring the live session in: the deferred channel resolves to
   * `live.channel` and Chat re-renders with `live.props`. Only valid once,
   * from the `booting` phase.
   */
  ready(live: LiveChat): void
  /**
   * The plugin has taken the slot (`takePrebootSlot`): from here on its
   * startup path owns the boot screen's fate — going live, a renderer
   * mismatch re-mount, or `handleStartupError`. Idempotent.
   */
  claim(): void
  /** The composer's current text (a mismatch fallback carries it into a fresh mount). */
  draft(): string
  /** Unmount and release the renderer (terminal restored). Idempotent. */
  dispose(): void
}

interface HostSnapshot {
  readonly props: ChatHostProps
}

interface HostStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): HostSnapshot
  set(props: ChatHostProps): void
}

function createHostStore(initial: ChatHostProps): HostStore {
  let snapshot: HostSnapshot = { props: initial }
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    set(props) {
      snapshot = { props }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Fires once the first frame with theme-resolved children has committed. */
function FirstFrameSignal({ onFirstFrame }: { onFirstFrame: () => void }): null {
  React.useEffect(() => {
    onFirstFrame()
  }, [onFirstFrame])
  return null
}

export function ChatHost({
  store,
  channel,
  fullscreen,
  promptControllerRef,
  onFirstFrame,
}: {
  store: HostStore
  channel: ChannelUi
  fullscreen: boolean
  promptControllerRef: React.RefObject<PromptController | null>
  onFirstFrame: () => void
}): React.ReactNode {
  const { props } = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const chat = (
    <Chat
      key="chat"
      {...props}
      channel={channel}
      fullscreen={fullscreen}
      promptControllerRef={promptControllerRef}
    />
  )
  // PageMargin sits INSIDE AlternateScreen: the alt-screen box sizes itself
  // to the real terminal rows while PageMargin reports content-box
  // dimensions to everything below it.
  const margined = <PageMargin>{chat}</PageMargin>
  return (
    <ThemeProvider themeHost={props.themeHost}>
      <FirstFrameSignal onFirstFrame={onFirstFrame} />
      {fullscreen ? <AlternateScreen>{margined}</AlternateScreen> : margined}
    </ThemeProvider>
  )
}

export interface MountChatHostOptions {
  fullscreen: boolean
  terminalImages: boolean
  /** The channel and props Chat renders with first (boot or already live). */
  initial: LiveChat
  /** Stream/console overrides (headless regressions). */
  renderOptions?: Pick<RenderOptions, 'stdout' | 'stdin' | 'stderr' | 'patchConsole'>
  /**
   * Resolve once the first frame with visible content has committed, or
   * after this many ms — whichever comes first. Terminal background
   * detection (ThemeProvider, OSC 11) normally answers in ~10ms and times
   * out at 400ms; the `dst` preload uses this so dsh does not start loading
   * (a ~1s synchronous block) before the screen is on.
   */
  firstFrameWaitMs?: number
  /**
   * Lifecycle edges of a slot mounted in its boot phase: `claimed` once the
   * plugin takes it, then `ready` or `disposed` when it leaves `booting`.
   * The `dst` preload arms its boot watchdog and exit backstop on these.
   */
  onLifecycle?: (event: 'claimed' | 'ready' | 'disposed') => void
}

/**
 * Mount the root tree and return its slot. Resolves when the first visible
 * frame has been committed (bounded by `firstFrameWaitMs`; default: do not
 * wait).
 */
export async function mountChatHost(options: MountChatHostOptions): Promise<BootSlot> {
  const deferred = createDeferredChannel(options.initial.channel)
  const store = createHostStore(options.initial.props)
  const promptControllerRef: React.RefObject<PromptController | null> = { current: null }
  let phase: BootSlotPhase = options.initial.channel.ready ? 'ready' : 'booting'
  let claimed = false
  let firstFramePainted: () => void = () => {}
  const firstFrame = new Promise<void>(resolve => {
    firstFramePainted = resolve
  })
  const tree = (
    <ChatHost
      store={store}
      channel={deferred.channel}
      fullscreen={options.fullscreen}
      promptControllerRef={promptControllerRef}
      onFirstFrame={() => firstFramePainted()}
    />
  )
  const instance = await render(tree, {
    ...options.renderOptions,
    exitOnCtrlC: false,
    terminalImages: options.terminalImages,
  })
  if (options.firstFrameWaitMs !== undefined && options.firstFrameWaitMs > 0) {
    await Promise.race([
      firstFrame,
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, options.firstFrameWaitMs)
        timer.unref?.()
      }),
    ])
  }
  return {
    channel: deferred.channel,
    fullscreen: options.fullscreen,
    terminalImages: options.terminalImages,
    mountedAt: performance.now(),
    get phase() {
      return phase
    },
    instance,
    ready(live) {
      if (phase !== 'booting') throw new Error(`dsh-tui: boot slot cannot go live from phase "${phase}"`)
      phase = 'ready'
      // Props first, channel second: the render the channel swap triggers
      // already sees the live stores and callbacks.
      store.set(live.props)
      deferred.resolve(live.channel)
      options.onLifecycle?.('ready')
    },
    claim() {
      if (claimed) return
      claimed = true
      options.onLifecycle?.('claimed')
    },
    draft() {
      return promptControllerRef.current?.text() ?? ''
    },
    dispose() {
      if (phase === 'disposed') return
      phase = 'disposed'
      // Before the teardown: a listener must never outlive the phase it
      // guards, even when unmount throws (revoked TTY).
      options.onLifecycle?.('disposed')
      instance.unmount()
      instance.cleanup()
    },
  }
}
