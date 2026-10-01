/**
 * verify-launchpad-onboarding-chat — 落地页 / 首次引导在**真实 Chat** 里的编排契约。
 *
 * 两个屏幕自己的回归（verify-launchpad / verify-onboarding-wizard）只挂孤立组件，
 * 夹具"照抄"Chat 的接线——接线一旦漂移，那边照绿。这一层专钉漂移，案例全部来自
 * 真实缺陷（审查 B 轮在人肉读码时发现的那三条都出在这里）：
 *
 *   A. `/setup` 打开向导：落地页里敲 `/setup` 回车 → 向导上屏、落地页收掉。
 *   B. 提交首句的落点：首启（openHomeOnBoot 与落地页同真）提交一句 → 落在对话页、
 *      草稿就在输入框里、会话浏览器**不再盖着**（它本来开着，只是被落地页盖住）。
 *   C. 会开整屏界面的快捷入口：会话与工作区 / 设置 / 快捷键 → 先把落地页收掉，
 *      否则目标屏的 early-return 排在落地页之后，点了等于没反应。
 *   D. 覆盖层动作（模型 / 主题 / 语言）不收落地页。
 *   E. 记账：向导里 Esc（跳过）**不写** onboarding.json；→→→Enter 走完才写。
 *   F. 最小模式：落地页整体不存在（launchpadVisible 真的接在渲染链上）。
 *   G. 首启 Tips 行（launchpad-first-run，首启专用文案）不再 stale：完成引导后
 *      它立刻换回平时的 launchpad-tip（跳过则保留首启那句，因为没记账）。
 *   H. 向导招式卡的"试一下"：会开整屏界面的命令同样先把向导收掉，不留滞留状态。
 *
 * 运行：node --import tsx/esm scripts/verify-launchpad-onboarding-chat.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import fakeHome from './lib/fake-home.mjs' // 必须最先：DATA_DIR 在 import 时定死
import xterm from '@xterm/headless'
import { settle, settled, viewportLines } from './lib/term-test.mjs'
const { Terminal: XTerm } = xterm

const [
  { render, Box, ThemeProvider },
  { Chat },
  { LOCAL_COMMANDS },
  { QuestionStore },
  { setMinimalUiMode },
  { readOnboardingPrefs },
  { isLandingLaunch },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/minimalUiMode.js'),
  import('../src/onboardingPrefs.js'),
  import('../src/dsh-adapter/plugin.js'),
])

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 120
const ROWS = 36

class FakeStdout extends Writable {
  isTTY = true
  readonly frames: string[] = []
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns() { return this.terminal.cols }
  get rows() { return this.terminal.rows }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    this.frames.push(String(chunk))
    this.terminal.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const plainText = (frames: readonly string[]) => frames.join('')
  .replace(/\x1b\[(\d+)C/g, (_m: string, n: string) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')

/** 桩 channel：Chat 只读它渲染要用的面（形状取自 verify-whale-girl 的 smoke 夹具）。 */
function makeChannel(over: Record<string, unknown> = {}) {
  const notifications: string[] = []
  const calls: string[] = []
  const channel = {
    version: 0,
    whaleIdle: false,
    whale: false,
    whaleGirl: false,
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-chat',
    provider: 'deepseek',
    // 第四版落地页动作表读的真实信号：provider 已配（否则第一位入口会变成
    // 条件按钮 Set up provider，焦点步进的全套断言都要跟着换档）。
    configuredProvider: 'deepseek',
    reasoningEffort: 'high',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting' as const,
    mode: { plan: false },
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications,
    commandList: LOCAL_COMMANDS,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submit(text: string) { calls.push('submit:' + text) },
    steer() {},
    cancel() {},
    clear() {},
    notify(text: string) { notifications.push(text) },
    listModels: () => Promise.resolve([{ provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' }]),
    listProviders: () => Promise.resolve([{ id: 'deepseek', name: 'DeepSeek' }]),
    listEfforts: () => Promise.resolve({ efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }),
    listWorkspaces: () => Promise.resolve([]),
    describeCredential: () => Promise.resolve({ configured: true, source: 'env', writable: false }),
    balanceInfo: () => Promise.resolve({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110 }] }),
    setEffort: async () => true,
    switchModel: async () => true,
    switchWorkspace: async () => true,
    listSessions: () => [],
    setResumeTarget: () => {},
    ...over,
  }
  return { channel, notifications, calls }
}

interface Flags {
  launchpadOnBoot?: boolean
  onboardingOnBoot?: boolean
  openHomeOnBoot?: boolean
}

async function mountChat(flags: Flags, over: Record<string, unknown> = {}) {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  const stdin = new FakeStdin()
  const { channel, notifications, calls } = makeChannel(over)
  const instance = await render(
    <ThemeProvider theme="dark">
      {/* 与真机同构：根是整屏尺寸（Chat 的每个整屏 early-return 都按整屏排版）。 */}
      <Box width={COLS} height={ROWS} flexDirection="column">
        <Chat
          channel={channel as never}
          questionStore={new QuestionStore()}
          starPrompt={null}
          openHomeOnBoot={flags.openHomeOnBoot === true}
          launchpadOnBoot={flags.launchpadOnBoot === true}
          onboardingOnBoot={flags.onboardingOnBoot === true}
        />
      </Box>
    </ThemeProvider>,
    { stdin: stdin as never, stdout: stdout as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  /** 当前屏幕（xterm 视口）。用视口而不是 painted 流的最后一帧：ink 会分块写，
   *  最后一帧往往只是碎片，断言会读到半个屏。 */
  const screen = () => viewportLines(term).join('\n')
  const send = async (data: string) => {
    const before = stdout.frames.length
    stdin.write(data)
    await settle(() => stdout.frames.length > before, { timeoutMs: 400 })
  }
  const type = async (text: string) => { for (const ch of text) await send(ch) }
  return { term, stdout, stdin, notifications, calls, screen, send, type, unmount: async () => { await instance.unmount() } }
}

const LAUNCHPAD_MARK = '说点什么，或输入 /' + ' 看命令…'
const WIZARD_MARK = '第 1 / 4 步'

// ── A. /setup 打开向导 ─────────────────────────────────────────────────────
{
  const chat = await mountChat({ launchpadOnBoot: true })
  check('A1 普通启动落在落地页', await settled(() => chat.screen().includes('说点什么')))
  await chat.type('/setup')
  await chat.send('\r')
  check('A2 落地页里 /setup 打开向导（落地页同时收掉）',
    await settled(() => chat.screen().includes(WIZARD_MARK) && !chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  await chat.unmount()
}

// ── B. 提交首句的落点（首启：会话浏览器也开着） ─────────────────────────────
{
  const chat = await mountChat({ launchpadOnBoot: true, openHomeOnBoot: true })
  check('B1 落地页盖在会话浏览器之上', await settled(() => chat.screen().includes('说点什么')))
  await chat.type('你好')
  await chat.send('\r')
  check('B2 提交后不再显示落地页', await settled(() => !chat.screen().includes('说点什么')))
  check('B3 也不再显示会话浏览器（草稿要落在眼前的对话里）',
    await settled(() => !chat.screen().includes('工作区')) , chat.screen().slice(0, 240))
  check('B4 首句进了输入框（草稿交回，不是被吞）', await settled(() => chat.screen().includes('你好')))
  check('B5 交接提示发过一条', chat.notifications.some(n => n.length > 0), JSON.stringify(chat.notifications))
  await chat.unmount()
}

// ── C. 会开整屏界面的快捷入口（回归：曾经点了没反应） ───────────────────────
{
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B') // 焦点落到第一条入口（第四版常态档第一位 = 历史会话）
  await chat.send('\r')
  check('C1 历史会话：落地页收掉、会话管理真上屏（动作有可见效果）',
    await settled(() => !chat.screen().includes('说点什么') && chat.screen().includes('新建会话')),
    chat.screen().slice(0, 300))
  await chat.unmount()
}

// ── D. 覆盖层动作不收落地页 ───────────────────────────────────────────────
{
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B')
  await chat.send('\u001b[B')
  await chat.send('\u001b[B') // 第三条 = 模型（覆盖层）
  await chat.send('\r')
  check('D1 切换模型：落地页留着（覆盖层渲染在它之上）',
    await settled(() => chat.screen().includes('说点什么')), chat.screen().slice(0, 240))
  await chat.unmount()
}

// ── E. 记账：skipped 不写、done 才写 ──────────────────────────────────────
{
  const prefsDir = join(fakeHome, '.dsh-tui')
  const chat = await mountChat({ onboardingOnBoot: true })
  await settled(() => chat.screen().includes(WIZARD_MARK))
  await chat.send('\u001b')
  await settled(() => !chat.screen().includes(WIZARD_MARK))
  check('E1 Esc 跳过：onboarding.json 不存在（不记账）',
    readOnboardingPrefs(prefsDir).completed === false, JSON.stringify(readOnboardingPrefs(prefsDir)))
  await chat.unmount()
}
{
  const prefsDir = join(fakeHome, '.dsh-tui')
  const chat = await mountChat({ onboardingOnBoot: true })
  await settled(() => chat.screen().includes(WIZARD_MARK))
  for (let i = 0; i < 3; i++) await chat.send('\u001b[C')
  await settled(() => chat.screen().includes('第 4 / 4 步'))
  await chat.send('\r') // 第一张是键位卡 → 完成
  check('E2 走到最后一步按 Enter：写进 onboarding.json',
    await settled(() => readOnboardingPrefs(prefsDir).completed === true), JSON.stringify(readOnboardingPrefs(prefsDir)))
  check('E3 完成后向导收掉（回到落地页）', await settled(() => !chat.screen().includes('第 4 / 4 步')))
  check('E4 首启 Tips 文案随之消失（不再 stale，换回平时那句）',
    !chat.screen().includes('第一次用 dsh-TUI'), chat.screen().slice(0, 200))
  await chat.unmount()
}
{
  const chat = await mountChat({ onboardingOnBoot: true, launchpadOnBoot: true })
  await settled(() => chat.screen().includes(WIZARD_MARK))
  await chat.send('\u001b')
  await settled(() => chat.screen().includes('说点什么'))
  check('E5 跳过之后落地页仍带首启 Tips 文案（没记账，下次还会问）',
    chat.screen().includes('第一次用 dsh-TUI'), chat.screen().slice(0, 200))
  await chat.unmount()
}

// ── F. 最小模式：落地页整体不存在 ────────────────────────────────────────
{
  setMinimalUiMode(true)
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().length > 0)
  check('F1 最小模式下不画落地页（launchpadVisible 真的接在渲染链上）',
    !chat.screen().includes('说点什么'), chat.screen().slice(0, 200))
  await chat.unmount()
  setMinimalUiMode(false)
}

// ── H. 向导招式卡的「试一下」（同 C 的一类问题） ──────────────────────────
{
  const chat = await mountChat({ onboardingOnBoot: true })
  await settled(() => chat.screen().includes(WIZARD_MARK))
  for (let i = 0; i < 3; i++) await chat.send('\u001b[C')
  await settled(() => chat.screen().includes('第 4 / 4 步'))
  await chat.send('\u001b[B') // 第二张 = 帮助与快捷键（命令卡）
  await chat.send('\r')
  check('H1 试一下会开整屏界面的命令：向导先收掉（不留滞留状态）',
    await settled(() => !chat.screen().includes('第 4 / 4 步')), chat.screen().slice(0, 300))
  check('H2 落回对话页而不是空白/卡死（命令真的跑了）',
    await settled(() => chat.screen().includes('deepseek-chat')), chat.screen().slice(0, 200))
  await chat.unmount()
}

// ── I. 启动口径（实测事故：本机 dst 每次都喂 DSH_TUI_WORKSPACE_TARGET，
//      旧判定把工作区目标算进「非普通启动」→ 两个屏在主流启动方式下永远不出） ──
{
  check('I1 无 resume、无首句 → 普通启动（工作区目标不参与判定，dst 场景）',
    isLandingLaunch({ initialPrompt: '' }) === true)
  check('I2 有 resume 目标 → 不是普通启动（用户说了回哪儿）',
    isLandingLaunch({ launchSessionId: 'abc', initialPrompt: '' }) === false)
  check('I3 带首句提示词 → 不是普通启动（用户说了要干什么）',
    isLandingLaunch({ initialPrompt: '跑一下测试' }) === false)
  check('I4 工作区目标在签名里根本不存在（这条判定再也收不到它）',
    isLandingLaunch.length <= 1)
}

if (failures === 0) console.log(`\nverify-launchpad-onboarding-chat: ${checks} checks, all passed`)
else console.error(`\nverify-launchpad-onboarding-chat: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)