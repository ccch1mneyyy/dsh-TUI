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
  let lastConfirmedReport = ''
  let disposed = false

  let running = false
  let notifySettled: (() => void) | undefined
  let settledPromise: Promise<void> = Promise.resolve()

  const ensureSettledPromise = (): void => {
    if (!notifySettled) {
      settledPromise = new Promise<void>((resolve) => {
        notifySettled = resolve
      })
    }
  }

  const triggerSettled = (): void => {
    if (notifySettled) {
      const fn = notifySettled
      notifySettled = undefined
      fn()
    }
  }

  const computeState = (): { state: 'idle' | 'working' | 'blocked'; blocked: boolean } => {
    const blocked = options.questions.getSnapshot() !== null || options.approvals.getSnapshot() !== null
    const state = blocked ? 'blocked' : options.channel.working ? 'working' : 'idle'
    return { state, blocked }
  }

  const processQueue = async (): Promise<void> => {
    if (running) return
    running = true

    try {
      while (!disposed) {
        const { state, blocked } = computeState()
        if (state === lastConfirmedReport) {
          break
        }

        const seq = String(++sequence)
        try {
          const res = await run(executable, [
            'pane', 'report-agent', paneId,
            '--source', 'custom:dsh-tui',
            '--agent', 'dsh-tui',
            '--state', state,
            ...(blocked ? ['--message', 'Waiting for user input'] : []),
            '--seq', seq,
          ])
          if (res?.code === 0) {
            lastConfirmedReport = state
          } else {
            break
          }
        } catch {
          break
        }
      }
    } finally {
      running = false
      triggerSettled()
    }
  }

  const report = (): void => {
    if (disposed) return
    const { state } = computeState()
    if (state === lastConfirmedReport && !running) return

    ensureSettledPromise()
    void processQueue()
  }

  const unsubscribes = [
    options.channel.subscribe(report),
    options.questions.subscribe(report),
    options.approvals.subscribe(report),
  ]
  report()

  let disposePromise: Promise<void> | undefined

  return {
    settled: () => (running ? settledPromise : Promise.resolve()),
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise
      disposed = true
      for (const unsubscribe of unsubscribes) unsubscribe()

      disposePromise = (async () => {
        while (running) {
          await settledPromise
        }
        const seq = String(++sequence)
        try {
          await run(executable, [
            'pane', 'release-agent', paneId,
            '--source', 'custom:dsh-tui',
            '--agent', 'dsh-tui',
            '--seq', seq,
          ])
        } catch {
          // Rejection isolated
        }
      })()

      return disposePromise
    },
  }
}
