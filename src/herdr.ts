import { execFileNoThrow, type ExecFileNoThrowResult } from './utils/execFileNoThrow.js'

interface HerdrChannel {
  readonly working: boolean
  subscribe(listener: () => void): () => void
}

interface BlockingStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): unknown | null
}

type RunCommand = (file: string, args: readonly string[]) => Promise<ExecFileNoThrowResult>

export interface HerdrIntegration {
  settled(): Promise<void>
  dispose(): Promise<void>
}

export interface HerdrIntegrationOptions {
  readonly channel: HerdrChannel
  readonly questions: BlockingStore
  readonly approvals: BlockingStore
  readonly env?: NodeJS.ProcessEnv
  readonly run?: RunCommand
}

/**
 * Report this TUI's lifecycle to the owning Herdr pane when Herdr launches it.
 * Outside Herdr the integration is absent and has no runtime cost.
 */
export function attachHerdrIntegration(
  options: HerdrIntegrationOptions,
): HerdrIntegration | undefined {
  const env = options.env ?? process.env
  const executable = env.HERDR_BIN_PATH?.trim()
  const paneId = env.HERDR_PANE_ID?.trim()
  if (env.HERDR_ENV !== '1' || !executable || !paneId) return undefined

  const run = options.run ?? ((file, args) => execFileNoThrow(file, args, { timeout: 2000 }))
  let sequence = 0
  let pending = Promise.resolve()
  let lastReport = ''
  const report = (): void => {
    const blocked = options.questions.getSnapshot() !== null || options.approvals.getSnapshot() !== null
    const state = blocked ? 'blocked' : options.channel.working ? 'working' : 'idle'
    if (state === lastReport) return
    lastReport = state
    const seq = String(++sequence)
    pending = pending.then(async () => {
      await run(executable, [
        'pane', 'report-agent', paneId,
        '--source', 'custom:dsh-tui',
        '--agent', 'dsh-tui',
        '--state', state,
        ...(blocked ? ['--message', 'Waiting for user input'] : []),
        '--seq', seq,
      ])
    })
  }
  const unsubscribes = [
    options.channel.subscribe(report),
    options.questions.subscribe(report),
    options.approvals.subscribe(report),
  ]
  report()
  let disposePromise: Promise<void> | undefined

  return {
    settled: () => pending,
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise
      for (const unsubscribe of unsubscribes) unsubscribe()
      const seq = String(++sequence)
      pending = pending.then(async () => {
        await run(executable, [
          'pane', 'release-agent', paneId,
          '--source', 'custom:dsh-tui',
          '--agent', 'dsh-tui',
          '--seq', seq,
        ])
      })
      disposePromise = pending
      return disposePromise
    },
  }
}
