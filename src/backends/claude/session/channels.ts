/** Assemble the session's model, mode and relay-channel controls. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentEvent } from '../../../agent/events.js'
import type { AgentSession } from '../../../agent/session.js'
import { DATA_DIR } from '../../../utils/paths.js'
import type { ClaudeAuthPlan } from '../auth.js'
import { activeProfileOf, type ClaudeChannels } from '../channels.js'
import type { ClaudeChannelTokens } from '../channelTokens.js'
import { createClaudeControls } from '../controls.js'
import { importedModelEnv, modelTruthFrom, readLocalModelNames } from '../modelEnv.js'
import type { ClaudePrefs } from '../prefs.js'
import type { ClaudeTranslator } from '../translate.js'
import type { ClaudeSessionDeps, Run } from './types.js'

export function createSessionControls(context: {
  readonly deps: ClaudeSessionDeps
  readonly prefs: ClaudePrefs
  readonly channels: ClaudeChannels
  readonly channelTokens: ClaudeChannelTokens
  readonly translator: ClaudeTranslator
  readonly run: Run
  readonly authPlan: ClaudeAuthPlan
  readonly session: AgentSession
  configDir(): string
  emit(events: readonly AgentEvent[]): void
}) {
  const { deps, prefs, channels, channelTokens, translator, configDir, emit } = context
  /** The env keys the TUI itself put into the spawn env: the auth plan's
   *  flag layer (the channel connection, or the first-party pin). The
   *  settings import leaves them out (it would re-import the channel the TUI
   *  activated); the model truth ranks them above the settings file, the
   *  flag > settings > inherited order the CLI applies. */
  const injectedEnvKeys = (): ReadonlySet<string> => new Set(Object.keys(context.authPlan.settings?.env ?? {}))

  const controls = createClaudeControls({
    query: () => context.run.query,
    emit: events => emit(events),
    submitText: async text => {
      await context.session.submit({ text, clientMessageId: randomUUID() }, 'turn')
    },
    currentModel: () => translator.model,
    currentMode: () => translator.mode ?? deps.start.mode,
    noteModel: model => translator.noteModel(model),
    noteMode: mode => translator.noteMode(mode),
    prefs,
    channels,
    tokens: channelTokens,
    debug: deps.host.debug,
    // "Import from settings" reads the user's settings file plus the
    // inherited env (settings first, as the CLI does), without the TUI's own
    // injections: a cc-switch-written settings.json is what it sees.
    settingsEnv: () => importedModelEnv(
      configDir(),
      context.authPlan.env,
      injectedEnvKeys(),
    ),
    // Channel model truth, lazily (the list reads it on demand): the active
    // channel profile first (channels.json — the user's own data), then the
    // settings env of the same config dir the transcripts use, plus the
    // live auth env on top. A cosmetic tier name a relay channel wrote
    // must not hide the model that actually serves the request.
    modelTruth: () => {
      const active = activeProfileOf(channels.read())
      return modelTruthFrom(
        configDir(),
        context.authPlan.env,
        readLocalModelNames(join(DATA_DIR, 'backends', 'claude')),
        active === undefined ? undefined : { models: active.models, tiers: active.tiers },
        injectedEnvKeys(),
      )
    },
  })
  return controls
}
