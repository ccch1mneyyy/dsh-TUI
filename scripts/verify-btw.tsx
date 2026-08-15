/**
 * Headless verification for /btw (CC side question): renders the Chat screen
 * against a fake channel and exercises the five contracts —
 *  1. idle trigger opens the overlay and streams the answer in,
 *  2. a working channel still opens it (no steer into the running turn),
 *  3. Space dismisses it,
 *  4. bare /btw notifies usage,
 *  5. wrapSideQuestion/runSideQuestion behave over a fake chunk stream
 *     (assembled answer + abort short-circuit).
 * Follows smoke.tsx: FakeStdout/FakeStderr/FakeStdin + plainText ANSI wash.
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { render }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS }, { wrapSideQuestion, runSideQuestion }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/sideQuestion.js'),
])

class FakeStdout extends Writable {
  columns = 100
  rows = 28
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const plainText = (frames: string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Fake channel in smoke.tsx's shape, plus the btw seams. */
function makeChannel() {
  return {
    version: 0,
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 120, output: 45 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting' as const,
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    commandList: LOCAL_COMMANDS,
    notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submitCalls: [] as string[],
    steerCalls: [] as string[],
    notifyCalls: [] as string[],
    submit(text: string) { this.submitCalls.push(text) },
    steer(text: string) { this.steerCalls.push(text) },
    cancel() {},
    clear() {},
    notify(text: string) { this.notifyCalls.push(text) },
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    async sideQuestion(
      _question: string,
      options?: { onText?: (delta: string) => void },
    ): Promise<{ answer: string | null; error?: string }> {
      // Deterministic stream: both deltas land within ~60ms, so any overlay
      // older than the settle window shows the answer text (the working
      // assertion keys on the ANSWER, not the spinner, which the fake's
      // near-instant fill would already have replaced).
      options?.onText?.('The answer is ')
      await delay(40)
      options?.onText?.('**42**.')
      return { answer: 'The answer is **42**.' }
    },
  }
}

// ── Scenario 1: idle trigger opens the overlay and streams the answer ──
{
  const channel = makeChannel()
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} />,
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await delay(400)
  stdin.write('/btw what is the answer?\r')
  await delay(700)
  const openedMark = stdout.frames.length
  const opened = plainText(stdout.frames.slice(0, openedMark)).includes('what is the answer?')
  const streamed = plainText(stdout.frames.slice(0, openedMark)).includes('42')
  const noTranscript = channel.submitCalls.length === 0 && channel.steerCalls.length === 0
  console.log('scenario1 idle trigger opens + streams + leaves transcript untouched:',
    opened, streamed, noTranscript)

  // ── Scenario 2: Space dismisses, then /btw on a working channel ──────
  // (assertions read only frames AFTER the close key: the diff renderer
  // repaints deltas, so earlier frames still hold the panel text)
  stdin.write(' ')
  await delay(250)
  const afterClose = plainText(stdout.frames.slice(openedMark))
  const closedOk = !afterClose.includes('what is the answer?')
  channel.working = true
  const workingMark = stdout.frames.length
  stdin.write('/btw again?\r')
  await delay(700)
  const working = plainText(stdout.frames.slice(workingMark))
  const workingOk = working.includes('again?') && working.includes('42')
  const notSteered = channel.steerCalls.length === 0
  console.log('scenario2 Space dismisses; working-channel opens without steering:',
    closedOk, workingOk, notSteered)

  // ── Scenario 3: Space closes the working-channel overlay too ─────────
  const closeMark = stdout.frames.length
  stdin.write(' ')
  await delay(250)
  console.log('scenario3 Space dismisses overlay:', !plainText(stdout.frames.slice(closeMark)).includes('again?'))

  await instance.unmount()
}
// ── Scenario 4: bare /btw notifies usage ───────────────────────────────
{
  const channel = makeChannel()
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} />,
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await delay(400)
  stdin.write('/btw\r')
  await delay(300)
  const usageNotified = channel.notifyCalls.some(text => text.includes('用法：/btw'))
  console.log('scenario4 bare /btw notifies usage:', usageNotified)
  await instance.unmount()
}

// ── Scenario 5: wrapper + runner over a fake chunk stream ──────────────
{
  const wrapped = wrapSideQuestion('what?')
  const wrappedOk = wrapped.startsWith('<system-reminder>') && wrapped.includes('what?') && wrapped.includes('NO tools available')
  const chunks: unknown[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'ok ' },
    { type: 'text-delta', index: 0, text: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'ok text' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const deltas: string[] = []
  const fakeStream = async function* () { yield* chunks }
  const ok = await runSideQuestion({ stream: fakeStream as never, options: {}, onText: d => deltas.push(d) })
  const okAnswer = ok.answer === 'ok text' && deltas.join('') === 'ok text'
  const controller = new AbortController()
  controller.abort()
  // A real adapter's stream rejects with an AbortError once the signal fires.
  const abortingStream = async function* () {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
  const aborted = await runSideQuestion({
    stream: abortingStream as never,
    options: {},
    signal: controller.signal,
  })
  console.log('scenario5 wrapper + runner (answer/abort):', wrappedOk, okAnswer, aborted.answer === null && aborted.error === undefined)
}

process.exit(0)
