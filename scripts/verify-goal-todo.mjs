/**
 * Headless verification of the GoalTodoPanel: renders the compiled component
 * with fake channel data and asserts the visible output. Also simulates the
 * "data arrives later" path (a live channel emits after a goal mutation or
 * todo write) to prove the panel updates without a restart.
 *
 * Run with plain node against the compiled lib (tsx/esbuild is broken under
 * WSL here): `node scripts/verify-goal-todo.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { GoalTodoPanel } from '../lib/types/components/GoalTodoPanel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const toPlain = s =>
  s
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const baseChannel = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: '',
  agentId: 'a1',
  model: 'm',
  tokens: { input: 0, output: 0 },
  cwd: '.',
  gitBranch: undefined,
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: '',
  notifications: [],
  contextWindow: undefined,
  reasoningEffort: undefined,
  lastUsage: undefined,
  tps: undefined,
  tpsSamples: [],
  workingActivity: undefined,
  activityFrames: undefined,
  activityEnabled: false,
  contextBarEnabled: true,
  commandList: [],
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  subscribe() { return () => {} },
  submit() {},
  cancel() {},
  clear() {},
  notify() {},
  listFiles: async () => [],
  listModels: async () => [],
  runExternalCommand: async () => undefined,
  rewindTo: async () => null,
  resumeTo: async () => true,
  newSession: async () => true,
  switchModel: async () => true,
  loadOlder: () => 0,
  setActivityFrames: () => true,
  emit() {},
  goal: undefined,
  todos: [],
}

async function run() {
  // 1. Empty channel -> nothing rendered.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const instance = await render(
      React.createElement(GoalTodoPanel, { channel: { ...baseChannel } }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(500)
    const frame = toPlain(stdout.frames.join(''))
    check('empty channel renders nothing', frame.trim() === '', JSON.stringify(frame))
    instance.unmount()
  }

  // 2. Goal + todos present.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = {
      ...baseChannel,
      goal: {
        id: 'g1',
        revision: 3,
        objective: 'Fix the login page crash',
        phase: 'active',
        maxGoalRounds: 10,
        roundsStarted: 2,
      },
      todos: [
        { content: 'Reproduce the crash', status: 'completed' },
        { content: 'Fix the null deref in auth', status: 'in_progress' },
        { content: 'Add a regression test', status: 'pending' },
      ],
    }
    const instance = await render(
      React.createElement(GoalTodoPanel, { channel }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(500)
    const frame = toPlain(stdout.frames.join(''))
    console.log('--- GoalTodoPanel frame ---')
    console.log(JSON.stringify(frame))
    check('objective shown', frame.includes('Fix the login page crash'))
    check('phase badge + rounds shown', /active · 2\/10/.test(frame))
    check('completed todo shown', frame.includes('Reproduce the crash'))
    check('in-progress todo shown', frame.includes('Fix the null deref in auth'))
    check('pending todo shown', frame.includes('Add a regression test'))
    check('no transcript glue (no ❯ prompt)', !frame.includes('❯'))
    instance.unmount()
  }

  // 3. Blocked goal with reason.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = {
      ...baseChannel,
      goal: {
        id: 'g2',
        revision: 5,
        objective: 'Ship the release',
        phase: 'blocked',
        maxGoalRounds: 5,
        roundsStarted: 4,
        blockedReason: { code: 'stale-deps', message: 'CI is red: dependency update broke the build' },
      },
    }
    const instance = await render(
      React.createElement(GoalTodoPanel, { channel }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(500)
    const frame = toPlain(stdout.frames.join(''))
    check('blocked phase shown', /blocked · 4\/5/.test(frame))
    check('block reason shown', frame.includes('CI is red: dependency update broke the build'))
    instance.unmount()
  }

  // 4. Live update: data arrives after mount (simulates a channel.emit from
  //    a goal/change or todo/write event re-rendering the Chat screen).
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = { ...baseChannel }
    const App = () => {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        // Simulate the channel mutating + notifying subscribers.
        const t = setTimeout(() => {
          channel.goal = {
            id: 'g3',
            revision: 1,
            objective: 'Polish the panel',
            phase: 'active',
            maxGoalRounds: 3,
            roundsStarted: 0,
          }
          channel.todos = [
            { content: 'Render live', status: 'in_progress' },
            { content: 'Ship it', status: 'pending' },
          ]
          force(n => n + 1)
        }, 500)
        return () => clearTimeout(t)
      }, [])
      return React.createElement(GoalTodoPanel, { channel })
    }
    const instance = await render(React.createElement(App), {
      stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false,
    })
    await sleep(300)
    const before = toPlain(stdout.frames.join(''))
    check('nothing before data arrives', before.trim() === '', JSON.stringify(before))
    await sleep(600)
    const after = toPlain(stdout.frames.at(-1) ?? '')
    check('panel appears after live update', after.includes('Polish the panel') && after.includes('Render live'), JSON.stringify(after))
    instance.unmount()
  }

  process.exit(failed)
}

run()
