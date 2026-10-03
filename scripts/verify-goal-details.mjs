/**
 * Long goals: keyboard/click access, wrapped scrollable full text, hover
 * gating, modal input isolation, resize and goal/session retirement.
 * Run: node --import tsx/esm scripts/verify-goal-details.mjs
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const [React, { Writable, PassThrough }, { Terminal }, { render, AlternateScreen }, { Chat },
  { GoalTodoPanel }, { TooltipLayer, getTooltipSnapshot, clearTooltip },
  { setKeymapOverrides, resetKeymapOverrides }, { settled, settle, viewportLines, findText }, { setLang, t }, { QuestionStore }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/components/GoalTodoPanel.js'),
  import('../src/components/Tooltip.js'), import('../src/utils/keymap.js'), import('./lib/term-test.mjs'), import('../src/i18n.js'), import('../src/dsh-adapter/questions.js'),
])
let failed = 0
function check(name, ok) { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`); if (!ok) failed++ }
function makeTerm(columns = 90, rows = 24) {
  const term = new Terminal({ cols: columns, rows, scrollback: 1000, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
  Object.assign(stdout, { columns, rows, isTTY: true })
  const stderr = new Writable({ write(_chunk, _enc, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } })
  const screen = () => viewportLines(term, stdout.rows).join('\n')
  return { term, stdout, stderr, stdin, screen }
}
const objective = 'GOAL_HEAD ' + 'Validate recovered evidence, partial downloads and paired depth evaluations. '.repeat(50) + ' GOAL_TAIL'
function makeChannel() {
  const listeners = new Set()
  const channel = {
    version: 0, rows: [{ id: 0, kind: 'user', text: 'Keep working' }, { id: 1, kind: 'assistant', text: 'Ready.' }],
    agentId: 'goal-session', sessionTitle: 'probe', status: 'idle', model: 'm', provider: 'deepseek',
    cwd: '/tmp', displayCwd: '/tmp', working: false, spinnerMode: 'requesting', responseChars: 0,
    activeToolCount: 0, turnStart: 0, lastUserText: '', pending: [], notifications: [],
    tokens: { input: 0, output: 0 }, tpsSamples: [], contextBarEnabled: false, activityEnabled: false,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' }, modeIndex: 0,
    goal: { id: 'g1', revision: 1, objective, phase: 'active', roundsStarted: 0, maxGoalRounds: 12 }, todos: [],
    commandList: [], commandCompletions: () => [], listFiles: async () => [], listModels: async () => [],
    loadOlder: () => 0, notify() {}, cycleMode() {}, setResumeTarget() {}, submit() { channel.submitted++ },
    cancel() { channel.cancelled++ }, submitted: 0, cancelled: 0,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    emit() { channel.version++; for (const listener of listeners) listener() },
  }
  return channel
}
const { applySidePanelOpen, applySidePanelPanels } = await import('../src/tuiDisplayPrefs.js')
for (const lang of ['en', 'zh']) for (const mode of ['fullscreen', 'inline', 'split']) {
  const fullscreen = mode !== 'inline'
  applySidePanelOpen(mode === 'split')
  applySidePanelPanels('todo')
  setLang(lang)
  const title = t('goal-details-title')
  const io = makeTerm(mode === 'split' ? 120 : 90)
  const channel = makeChannel()
  const questionStore = new QuestionStore()
  const chat = React.createElement(Chat, {
    channel, fullscreen, questionStore, onExit() {},
  })
  const app = await render(fullscreen ? React.createElement(AlternateScreen, null, chat) : chat,
    { stdout: io.stdout, stderr: io.stderr, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false })
  const label = `${lang}/${mode}`
  check(`${label}: goal summary renders`, await settled(() => io.screen().includes('GOAL_HEAD')))
  if (mode === 'split') {
    io.stdin.write('\x02')
    check(`${label}: panel takes keyboard focus`, await settled(() => io.screen().includes(t('panel-hint-focused').split(' · ')[0])))
    io.stdin.write('\x1bg')
    check(`${label}: focused panel allows goal shortcut`, await settled(() => io.screen().includes(title)))
    io.stdin.write('\x1b')
    await settle(() => !io.screen().includes(title))
    io.stdin.write('\x1b')
    await settle(() => !io.screen().includes(title))
    const goalHit = findText(io.term, 'GOAL_HEAD')
    io.stdin.write(`\x1b[<0;${goalHit.col + 1};${goalHit.row + 1}M\x1b[<0;${goalHit.col + 1};${goalHit.row + 1}m`)
    check(`${label}: side-panel goal click opens details`, await settled(() => io.screen().includes(title)))
    io.stdin.write('\x1b[F')
    check(`${label}: goal tail reachable beside panel`, await settled(() => io.screen().includes('GOAL_TAIL')))
    io.stdin.write('\x1b')
    await settle(() => !io.screen().includes(title))
    io.stdin.write('\x1b')
    await settle(() => io.screen().includes(t('panel-hint-unfocused')))
    applySidePanelOpen(false)
    await settle(() => (findText(io.term, 'GOAL_HEAD')?.col ?? 120) < 60)
  }
  io.stdin.write('draft')
  await settle(() => io.screen().includes('draft'))
  if (fullscreen) {
    const goalHit = findText(io.term, 'GOAL_HEAD')
    io.stdin.write(`\x1b[<0;${goalHit.col + 1};${goalHit.row + 1}M\x1b[<0;${goalHit.col + 1};${goalHit.row + 1}m`)
  } else io.stdin.write('\x1bg')
  check(`${label}: ${fullscreen ? 'click' : 'Alt+G'} opens details`, await settled(() => io.screen().includes(title)))
  check(`${label}: body is windowed, dismissal hint visible`, !io.screen().includes('GOAL_TAIL') && io.screen().includes('Esc'))
  check(`${label}: hint has no underlying goal residue`, io.screen().split('\n').find(line => line.includes('↑/↓'))?.trim() === t('goal-details-hint'))
  io.stdin.write('leak')
  io.stdin.write('\r')
  check(`${label}: typing/Enter do not submit or dismiss`, await settled(() => io.screen().includes(title)) && channel.submitted === 0)
  io.stdin.write('\x1b[6~')
  check(`${label}: PageDown scrolls the goal body`, await settled(() => !io.screen().includes('GOAL_HEAD') && io.screen().includes(title)))
  io.stdin.write('\x1b[H')
  await settle(() => io.screen().includes('GOAL_HEAD'))
  io.stdin.write('\x1b[B')
  check(`${label}: Down scrolls the goal body`, await settled(() => !io.screen().includes('GOAL_HEAD') && io.screen().includes(title)))
  io.stdin.write('\x1b[F')
  check(`${label}: End reaches the full goal tail`, await settled(() => io.screen().includes('GOAL_TAIL')))
  io.stdin.write('\x1b[H')
  check(`${label}: Home returns to goal head`, await settled(() => io.screen().includes('GOAL_HEAD') && !io.screen().includes('GOAL_TAIL')))
  if (fullscreen) {
    const hit = findText(io.term, 'GOAL_HEAD')
    if (hit) for (let i = 0; i < 100; i++) io.stdin.write(`\x1b[<65;${hit.col + 1};${hit.row + 1}M`)
    check('fullscreen: wheel reaches goal tail', await settled(() => io.screen().includes('GOAL_TAIL')))
  }
  io.term.resize(54, 18)
  io.stdout.columns = 54; io.stdout.rows = 18; io.stdout.emit('resize')
  check(`${label}: resize keeps details and controls visible`, await settled(() => io.screen().includes(title) && io.screen().includes('Esc')))
  io.stdin.write('\x1b[F')
  check(`${label}: tail remains reachable after narrow resize`, await settled(() => io.screen().includes('GOAL_TAIL')))
  channel.goal = { ...channel.goal, revision: 2, objective: 'UPDATED_HEAD ' + '新增目标内容测试换行。'.repeat(500) + ' UPDATED_TAIL' }
  channel.emit()
  check(`${label}: edited goal resets scroll and shows fresh text`, await settled(() => io.screen().includes('UPDATED_HEAD') && !io.screen().includes('GOAL_TAIL')))
  io.stdin.write('\x1b[F')
  check(`${label}: CJK goal tail is reachable`, await settled(() => io.screen().includes('UPDATED_TAIL')))
  channel.working = true; channel.emit()
  io.stdin.write('\x1b')
  check(`${label}: Esc closes without cancelling running agent`, await settled(() => !io.screen().includes(title)) && channel.cancelled === 0)
  check(`${label}: draft survives viewing details`, io.screen().includes('draft') && !io.screen().includes('leak'))
  setKeymapOverrides({ goalDetails: 'alt+j' })
  io.stdin.write('\x1bj')
  check(`${label}: remapped key opens details`, await settled(() => io.screen().includes(title)))
  resetKeymapOverrides()
  channel.agentId = 'other-session'; channel.emit()
  check(`${label}: switching sessions retires details`, await settled(() => !io.screen().includes(title)))
  io.stdin.write('\x1bg')
  await settle(() => io.screen().includes(title))
  channel.goal = undefined; channel.emit()
  check(`${label}: clearing goal retires details`, await settled(() => !io.screen().includes(title)))
  channel.goal = { id: 'g2', revision: 1, objective, phase: 'active', roundsStarted: 0, maxGoalRounds: 12 }
  channel.emit(); io.stdin.write('\x1bg')
  await settle(() => io.screen().includes(title))
  const questionResult = questionStore.ask({ questions: [{
    id: 'question', header: 'Review', question: 'QUESTION_INTERRUPTS',
    options: [{ label: 'Continue', description: 'Proceed with the task' }],
  }] })
  check(`${label}: incoming question takes priority over goal details`, await settled(() => io.screen().includes('QUESTION_INTERRUPTS') && !io.screen().includes(title)))
  io.stdin.write('\r')
  await questionResult
  await app.unmount(); io.term.dispose()
}
applySidePanelOpen(false)
// Hover is registered on the goal text only; fitting goals stay tooltip-silent.
{
  setLang('en')
  const io = makeTerm()
  const channel = makeChannel()
  channel.goal.objective = 'Short goal'
  let opened = 0
  const view = () => React.createElement(AlternateScreen, null,
    React.createElement(GoalTodoPanel, { channel, onOpenGoal: () => opened++ }), React.createElement(TooltipLayer))
  const app = await render(view(), { stdout: io.stdout, stderr: io.stderr, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false })
  check('short goal fits', await settled(() => io.screen().includes('Short goal')))
  // Trigger real pointer motion with a subscribed input consumer (Chat normally supplies it).
  const { useInput } = await import('../src/ui.js')
  function App() { useInput(() => {}); return view() }
  app.rerender(React.createElement(App))
  await settle(() => io.screen().includes('Short goal'))
  let hit = findText(io.term, 'Short goal')
  io.stdin.write(`\x1b[<35;${hit.col + 1};${hit.row + 1}M`)
  const { sleep } = await import('./lib/term-test.mjs')
  await sleep(700) // 固定窗:墙钟 tooltip dwell must finish before checking absence.
  check('fitting goal has no tooltip', getTooltipSnapshot() === null)
  io.stdin.write(`\x1b[<0;${hit.col + 1};${hit.row + 1}M\x1b[<0;${hit.col + 1};${hit.row + 1}m`)
  check('goal click opens details callback', await settled(() => opened === 1))
  io.stdin.write('\x1b[<35;1;1M')
  clearTooltip()
  channel.goal.objective = objective
  app.rerender(React.createElement(App))
  await settle(() => io.screen().includes('GOAL_HEAD'))
  hit = findText(io.term, 'GOAL_HEAD')
  io.stdin.write(`\x1b[<35;${hit.col + 1};${hit.row + 1}M`)
  check('truncated goal tooltip retains full objective', await settled(() => getTooltipSnapshot()?.content.includes('GOAL_TAIL')))
  io.stdin.write('\x1b[<35;1;1M')
  check('leaving goal clears tooltip', await settled(() => getTooltipSnapshot() === null))
  await app.unmount(); io.term.dispose(); clearTooltip()
}
process.exitCode = failed ? 1 : 0
