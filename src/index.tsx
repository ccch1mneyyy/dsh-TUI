import { randomUUID } from 'node:crypto'
import React from 'react'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import { createChannel } from './channel.js'
import { Chat } from './screens/Chat.js'
import { AlternateScreen, render, ThemeProvider } from './ui.js'

/**
 * Claude Code style interactive TUI front door for DeepSeek Harness agents.
 *
 * The plugin attaches to (or creates) one agent, renders a chat transcript
 * from the agent's session log and live `session/event` records, and submits
 * user turns through `Agent.followup`. It is a client-driver front door like
 * `dsh-jsonrpc`: the surrounding `cordis.yml` supplies the agent spine, the
 * LLM adapter, and the tool plugins.
 */
export const name = 'cc-tui'
export const inject = ['agents']

export interface Config {
  /** Existing session to attach; a fresh session is created when absent. */
  sessionId?: string
  /** LLM provider route; the harness `deepseek-official` route by default. */
  provider?: string
  /** Model override passed to the agent (adapter default when absent). */
  model?: string
  /** Session working directory; defaults to the invoking directory. */
  cwd?: string
  /** Configured reasoning effort, displayed from startup (the live value
   *  from request headers replaces it once the first turn runs). */
  effort?: string
  /** Show the dsh-working-activity live working line on the status bar
   *  (consumes its log-only `activity/status` events; off hides it). */
  activity?: boolean
  /** Working-activity indicator preset: `claude`/`moon`/`comet`/`dots`/…
   *  or `random` (see activityFrames.ts). */
  activityFrames?: string
  /** Run in the terminal's alternate screen (Claude Code fullscreen layout). */
  fullscreen?: boolean
}

export const Config: Schema<Config> = Schema.object({
  sessionId: Schema.string().required(false),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  cwd: Schema.string().required(false),
  effort: Schema.string().required(false),
  activity: Schema.boolean().default(true),
  activityFrames: Schema.string().default('claude'),
  fullscreen: Schema.boolean().default(true),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new Error('cc-tui requires an interactive terminal (stdout must be a TTY).')
  }

  const agentOptions = {
    provider: config.provider,
    model: config.model,
  }
  const meta = { cwd: config.cwd ?? process.cwd() }
  const { agent, handle } = await resolveAgent(ctx, config.sessionId, agentOptions, meta)

  const channel = createChannel(ctx, agent, {
    model: config.model ?? 'deepseek-v4-flash',
    cwd: config.cwd ?? process.cwd(),
    provider: config.provider ?? 'deepseek-official',
    effort: config.effort,
    activity: config.activity,
    activityFrames: config.activityFrames,
    handle,
  })
  const tree = (
    <ThemeProvider>
      <Chat channel={channel} onExit={() => disposeRootAndExit(ctx, 0)} />
    </ThemeProvider>
  )
  const instance = await render(tree, { exitOnCtrlC: false })

  // If the surrounding tree goes down (reload, teardown), take the TUI with it.
  ctx.effect(() => () => {
    void instance.unmount()
  })

  // The TUI is the front door: when it unmounts (Ctrl+C), dispose the app
  // tree and exit the process.
  void instance.waitUntilExit().then(() => {
    disposeRootAndExit(ctx, 0)
  })
}

/**
 * Attach to an existing agent, resume a persisted session (`dsh-cc --resume`
 * feeds the id through `config.sessionId`), or create a fresh one. Resume
 * goes through the DSH persistence seam (`ctx.agents.resume` reads the
 * session log written by dsh-session-persistence-jsonl); a missing artifact
 * or unmounted backend falls back to a fresh session, as does a plain boot
 * without a session id.
 */
async function resolveAgent(
  ctx: Context,
  requestedSessionId: string | undefined,
  agentOptions: { provider?: string; model?: string },
  meta: { cwd: string },
): Promise<{ agent: Agent; handle?: AgentHandle }> {
  if (requestedSessionId !== undefined) {
    const resumeId = SessionId(requestedSessionId)
    const existing = ctx.agents.get(resumeId)
    if (existing !== undefined) return { agent: existing }
    try {
      const resumed = await ctx.agents.resume({
        resumeSessionId: resumeId,
        agentOptions,
      })
      return { agent: resumed.agent, handle: resumed }
    } catch (error) {
      // No artifact (first run / cleared storage) or persistence not
      // mounted: fall through to a fresh session, but stay loud in the log.
      ctx.logger.warn(
        `cc-tui: resume of "${requestedSessionId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const sessionId = SessionId(randomUUID())
  const created = await ctx.agents.create({ sessionId, meta, agentOptions }).catch(error => {
    // Fail loud with the reason on stderr — a dead TUI with no message is
    // the worst outcome for a misconfigured leaf (unknown provider/model).
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `cc-tui: failed to create agent (provider=${agentOptions.provider ?? 'deepseek-official'}, model=${agentOptions.model ?? 'deepseek-v4-flash'}): ${message}`,
    )
  })
  return { agent: created.agent, handle: created }
}

/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * Mirrors the deleted dsh-tui front-door exit semantics.
 */
function disposeRootAndExit(ctx: Context, code: number): void {
  const timer = setTimeout(() => process.exit(code), 5000)
  timer.unref()
  void ctx.root.fiber.dispose().then(
    () => {
      clearTimeout(timer)
      process.exit(code)
    },
    () => {
      clearTimeout(timer)
      process.exit(code)
    },
  )
}
