import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { featureOn } from 'dsh-working-activity/config'
import { ActivityTracker, type TrackerConfig } from 'dsh-working-activity/status'
import { readActivityConfig } from '../../activityPrefs.js'
import type { ChannelOwner } from './owner.js'
import type { ActivityStatus, ChannelState } from './types.js'

/**
 * Owns the optional working-activity sidecar. It has no transcript authority:
 * callers route durable events to the sole projector separately, while this
 * object derives only a presentational status line and its 500ms clock.
 */
export function createChannelActivity(
  ctx: Context,
  state: ChannelState,
  owner: ChannelOwner,
  enabled: boolean,
) {
  const preferences = (): {
    config: TrackerConfig
    customActions?: Readonly<Record<string, readonly string[]>>
  } => {
    const config = readActivityConfig()
    if (config === undefined) {
      return { config: { phrases: true, detailLimit: 40, showIdle: false } }
    }
    return {
      config: {
        phrases: featureOn(config, 'phrases'),
        detailLimit: 40,
        showIdle: false,
        features: {
          rareEggs: featureOn(config, 'rareEggs'),
          weekend: featureOn(config, 'weekend'),
          holidays: featureOn(config, 'holidays'),
          nightPhrases: featureOn(config, 'nightPhrases'),
        },
        customPhrases: config.customPhrases,
        showTokPerSec: config.showTokPerSec,
        workRemindAt: config.workRemindAt,
      },
      customActions: config.customActions,
    }
  }

  let tracker = makeTracker()
  let timer: NodeJS.Timeout | undefined
  let failureReported = false

  function makeTracker(): ActivityTracker {
    const prefs = preferences()
    return new ActivityTracker(prefs.config, Date.now, prefs.customActions)
  }

  const render = (): ActivityStatus | undefined => {
    if (!enabled) {
      state.workingActivity = undefined
      return undefined
    }
    const rendered = tracker.render()
    state.workingActivity = rendered
    return rendered
  }

  const update = (source: string, action?: () => void): ActivityStatus | undefined => {
    try {
      action?.()
      return render()
    } catch (error: unknown) {
      if (!failureReported) {
        failureReported = true
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-tui: working-activity ignored ${source} after a projection error: ${detail}`)
      }
      return undefined
    }
  }

  const stop = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  // This resource is acquired before the first binding can fail. Own its
  // stop action immediately rather than relying on later root lifecycle setup.
  owner.own(stop)

  const start = (agent: Agent): void => {
    stop()
    tracker = makeTracker()
    failureReported = false
    update('agent bind', () => tracker.onAgentStatus(agent.status))
    timer = setInterval(() => {
      if (!owner.current()) { stop(); return }
      const previous = state.workingActivity
      const rendered = update('activity tick')
      if (rendered === undefined) return
      if (
        rendered.phase === 'waiting' ||
        rendered.phase === 'thinking' ||
        rendered.phase === 'tool' ||
        previous?.phase !== rendered.phase ||
        previous.line !== rendered.line
      ) state.emit()
    }, 500)
    timer.unref()
  }

  const onAgentStatus = (status: Agent['status']): ActivityStatus | undefined =>
    update(`agent/status:${status}`, () => tracker.onAgentStatus(status))

  const onSessionEvent = (event: SessionEvent): ActivityStatus | undefined =>
    update(`session/event:${event.type}`, () => {
      tracker.onSessionEvent(event)
      if (event.type === 'turn/end') {
        const reason = (event.data as { reason?: { kind?: string } }).reason
        if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') tracker.onInterrupted()
      }
    })

  return {
    start,
    stop,
    onAgentStatus,
    onSessionEvent,
    onModelSwitch(model: string) { return update('model switch', () => tracker.onModelSwitch(model)) },
    onCompact() { return update('compaction', () => tracker.onCompact('done')) },
    onGitBranch(branch: string) { return update('git branch', () => tracker.onGitBranch(branch)) },
  }
}
