/**
 * verify-launchpad-onboarding-chat — 落地页 / 首次引导在**真实 Chat** 里的编排契约。
 *
 * 两个屏幕自己的回归（verify-launchpad / verify-onboarding-wizard）只挂孤立组件，
 * 夹具"照抄"Chat 的接线——接线一旦漂移，那边照绿。这一层专钉漂移，案例全部来自
 * 真实缺陷（审查 B 轮在人肉读码时发现的那三条都出在这里）：
 *
 *   A. `/setup` 打开向导：落地页里敲 `/setup` 回车 → 向导盖在落地页之上；
 *      Esc 跳过**回到落地页**（第七版：不再收掉落地页落到对话页）。
 *   B. 提交首句的落点：提交一句 → 落在对话页、草稿就在输入框里、会话浏览器
 *      不再盖着（第七版起 boot 不预开浏览器，落地页是第一屏）。
 *   C. 会开整屏界面的快捷入口（第七版：**盖在落地页之上**，Esc 回落地页——
 *      从启动页进入对话页的唯一路径 = Enter 提交一条非命令消息）。
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
import { stringWidth } from '../src/ink/stringWidth.js'
const { Terminal: XTerm } = xterm

const [
  { render, Box, ThemeProvider },
  { Chat },
  { LOCAL_COMMANDS, completeCommands },
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

/** 目标文本的终端列号（1 起，SGR 鼠标用；按显示宽度换算，CJK 双宽点得准）。 */
function findCell(term: InstanceType<typeof XTerm>, needle: string): { col: number; row: number } | null {
  const lines = viewportLines(term)
  for (let row = 0; row < lines.length; row++) {
    const at = lines[row]!.indexOf(needle)
    if (at >= 0) return { col: stringWidth(lines[row]!.slice(0, at)) + 1, row: row + 1 }
  }
  return null
}

const plainText = (frames: readonly string[]) => frames.join('')
  .replace(/\x1b\[(\d+)C/g, (_m: string, n: string) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')

/**
 * 桩 channel：Chat 只读它渲染要用的面（形状取自 verify-whale-girl 的 smoke 夹具）。
 * 第五版扩展：参数行四段点开的选择器（/model · /effort · /preset · /permission）
 * 需要可变的 model/effort/preset/权限现状 + subscribe 通知（值就地更新靠它重渲染）。
 * 第六版扩展：命令补全面板（commandCompletions——直接用仓库的 completeCommands
 * 过滤同一张 commandList，与聊天页同源）+ agent preset 名册（/preset 段数据源）。
 */
function makeChannel(over: Record<string, unknown> = {}) {
  const notifications: string[] = []
  const calls: string[] = []
  const listeners: Array<() => void> = []
  const channel: Record<string, unknown> = {
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
    // plan / permission 由 dsh-base 注册为 external 命令（选择器打开的前提）。
    commandList: [...LOCAL_COMMANDS, { name: 'plan', external: true }, { name: 'permission', external: true }],
    // 命令补全面板（第六版 BUG 1）：与 composer 同源——completeCommands 过滤
    // 合并命令表（含上面的 registry 命令 plan）。
    commandCompletions: (input: string) => completeCommands(input, channel.commandList as never) as never,
    // agent preset（第六版设计 1：参数行"模式"段 = preset 显示名）。
    agentPreset: 'standard',
    listPresets: async () => [
      { id: 'standard', name: 'Standard', isDefault: true },
      { id: 'ptc', name: 'PTC', isDefault: false },
      { id: 'minimal', name: '极简', isDefault: false },
    ],
    switchPreset: async (id: string) => {
      channel.agentPreset = id
      calls.push('preset:' + id)
      bump()
      return true
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe(fn: () => void) { listeners.push(fn); return () => {} },
    submit(text: string) { calls.push('submit:' + text) },
    steer() {},
    cancel() {},
    clear() {},
    notify(text: string) { notifications.push(text) },
    listModels: () => Promise.resolve([
      { provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' },
      { provider: 'deepseek', id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ]),
    listProviders: () => Promise.resolve([{ id: 'deepseek', name: 'DeepSeek' }]),
    // ≥2 档 effort 才会开滑杆（1 档时 listEfforts 侧直接 notify 不开选择器）。
    listEfforts: () => Promise.resolve({
      efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
      defaultEffort: 'high',
    }),
    listWorkspaces: () => Promise.resolve([]),
    // Settings 整屏（第七版 C2：从落地页打开设置）只需要这三条缝；host
    // 给 undefined = 渲染「设置不可用」提示（真 channel 由 dsh-adapter 提供）。
    settingsHost: () => undefined,
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    describeCredential: () => Promise.resolve({ configured: true, source: 'env', writable: false }),
    balanceInfo: () => Promise.resolve({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110 }] }),
    setEffort: async (id: string) => {
      channel.reasoningEffort = id
      calls.push('effort:' + id)
      bump()
      return true
    },
    switchModel: async (provider: string, id: string) => {
      channel.provider = provider
      channel.model = id
      calls.push('switch:' + provider + '/' + id)
      bump()
      return true
    },
    switchWorkspace: async () => true,
    listSessions: () => [],
    setResumeTarget: () => {},
    // 权限名册（runtime）：/permission 选择器的数据源；写路径走 external 命令。
    permissionCurrent: 'default',
    permissionPresets: () => ({
      availability: 'runtime',
      options: [
        { value: 'default', name: 'default' },
        { value: 'strict', name: 'strict' },
      ],
      current: { value: channel.permissionCurrent, name: channel.permissionCurrent, kind: 'preset' },
    }),
    runPermissionPreset: async (value: string) => {
      const clean = value.trim()
      if (clean === '') return false
      channel.permissionCurrent = clean
      calls.push('permission:' + clean)
      bump()
      return true
    },
    runExternalCommandOutcome: async (name: string, rawInput: string) => {
      if (name === 'plan') {
        channel.mode = { plan: rawInput.trim() !== 'off' }
        calls.push('plan:' + ((channel.mode as { plan: boolean }).plan ? 'on' : 'off'))
        bump()
        return { kind: 'success' as const, text: '', consumeDraft: true as const }
      }
      if (name === 'permission') {
        const clean = rawInput.trim() === '' ? 'default' : rawInput.trim()
        channel.permissionCurrent = clean
        calls.push('permission:' + clean)
        bump()
        return { kind: 'success' as const, text: '', consumeDraft: true as const }
      }
      return undefined
    },
    ...over,
  }
  function bump(): void {
    channel.version = (channel.version as number) + 1
    for (const fn of listeners) fn()
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
  /** SGR 鼠标点击（列号按显示宽度换算，CJK 双宽才点得准）。 */
  const click = async (needle: string): Promise<void> => {
    await settled(() => {
      const cell = findCell(term, needle)
      return cell === null ? false : cell
    })
    const cell = findCell(term, needle)
    if (cell === null) throw new Error('click target not on screen: ' + needle)
    const before = stdout.frames.length
    stdin.write(`\u001b[<0;${cell.col};${cell.row}M\u001b[<0;${cell.col};${cell.row}m`)
    await settle(() => stdout.frames.length > before, { timeoutMs: 400 })
  }
  return { term, stdout, stdin, notifications, calls, screen, send, type, click, unmount: async () => { await instance.unmount() } }
}

const LAUNCHPAD_MARK = '说点什么，或输入 /' + ' 看命令…'
const WIZARD_MARK = '第 1 / 4 步'

// ── A. /setup 打开向导 ─────────────────────────────────────────────────────
{
  const chat = await mountChat({ launchpadOnBoot: true })
  check('A1 普通启动落在落地页', await settled(() => chat.screen().includes('说点什么')))
  await chat.type('/setup')
  await chat.send('\r')
  check('A2 落地页里 /setup 打开向导（向导盖在落地页之上）',
    await settled(() => chat.screen().includes(WIZARD_MARK) && !chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  // 第七版：Esc 跳过向导必须**回到落地页**（不再收掉落地页落到对话页）。
  // 草稿 '/setup' 还在输入框里（前缀 ⌘）——落地页状态原样保留。
  await chat.send('\x1b')
  check('A2b 向导 Esc 跳过回到落地页（不是对话页；草稿 /setup 原样在）',
    await settled(() => chat.screen().includes('⌘') && chat.screen().includes('/setup')
      && !chat.screen().includes(WIZARD_MARK)),
    chat.screen().slice(0, 200))
  await chat.unmount()
}

// ── B. 提交首句的落点（第五版：回车直接发送，与 composer 回车同一条路径）──────
{
  const chat = await mountChat({ launchpadOnBoot: true, openHomeOnBoot: true })
  check('B1 落地页是第一屏（第七版：boot 不预开会话浏览器）',
    await settled(() => chat.screen().includes('说点什么') && !chat.screen().includes('新建会话')),)
  await chat.type('你好')
  await chat.send('\r')
  check('B2 提交后不再显示落地页', await settled(() => !chat.screen().includes('说点什么')))
  // xterm 视口残留：新帧比落地页矮时底部行不清（'工作区' 那行会赖一拍）。
  // 敲一个键逼一帧全量重绘，B3 断的才是稳定终态而不是帧时序。
  await chat.send('x')
  check('B3 也不再显示会话浏览器（首句刚发进眼前的对话里）',
    await settled(() => !chat.screen().includes('工作区')), chat.screen().slice(0, 240))
  check('B4 首句直接发送：fake channel 的 submit 被调用、参数就是那行原文',
    chat.calls.includes('submit:你好'), JSON.stringify(chat.calls))
  check('B5 发出去之后不留草稿（输入框是空的，没有"已放进输入框"的假交接提示）',
    !chat.notifications.some(n => n.includes('输入框')) && !chat.notifications.some(n => n.includes('Enter 发送')),
    JSON.stringify(chat.notifications))
  await chat.unmount()
}
{
  // 行首 / 的本地命令仍走命令表（不触发模型提交）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.type('/help')
  await chat.send('\r')
  check('B6 命令行走命令表：不触发 channel.submit（本地命令不发模型）',
    await settled(() => !chat.screen().includes('说点什么')) && !chat.calls.some(c => c.startsWith('submit:')),
    JSON.stringify(chat.calls))
  await chat.unmount()
}

// ── C. 会开整屏界面的快捷入口（第七版：盖在落地页之上，Esc 回落地页）────────
{
  // 合并入口「会话与工作区」（home 那条）：打开后盖在落地页之上。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  // 焦点环 = 输入框 → 参数四段 → 入口：↓×5 落到第一条入口（会话与工作区）。
  for (let i = 0; i < 5; i++) await chat.send('\u001b[B')
  await chat.send('\r')
  check('C1 会话与工作区：会话管理上屏、盖在落地页之上（动作有可见效果）',
    await settled(() => !chat.screen().includes('说点什么') && chat.screen().includes('新建会话')),
    chat.screen().slice(0, 300))
  // 第七版硬约束回归①：从启动页开会话浏览 → Esc → 仍在启动页（不是对话页）。
  await chat.send('\x1b')
  check('C1b 会话浏览 Esc 退出 → 回到启动页（草稿/参数/焦点都在，不是对话页）',
    await settled(() => chat.screen().includes('说点什么') && !chat.screen().includes('新建会话')),
    chat.screen().slice(0, 300))
  await chat.unmount()
}
{
  // 设置入口（第三格）：Settings 整屏盖在落地页之上，Esc 回启动页。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  for (let i = 0; i < 6; i++) await chat.send('\u001b[B') // 第二条入口 = 设置
  await chat.send('\r')
  check('C2 设置入口：Settings 上屏、盖在落地页之上',
    await settled(() => !chat.screen().includes('说点什么') && chat.screen().length > 0),
    chat.screen().slice(0, 200))
  await chat.send('\x1b')
  check('C2b Settings Esc → 回到启动页',
    await settled(() => chat.screen().includes('说点什么')), chat.screen().slice(0, 200))
  await chat.unmount()
}
{
  // 空输入 Esc（去会话浏览的那条路）：同样盖在落地页之上、Esc 回启动页——
  // 用户实测 bug 原话：「ESC 退出来之后直接进入对话页面了，而不是启动页」。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\x1b')
  check('C3 空输入 Esc 打开会话浏览（盖在落地页之上）',
    await settled(() => !chat.screen().includes('说点什么') && chat.screen().includes('新建会话')),
    chat.screen().slice(0, 300))
  await chat.send('\x1b')
  check('C3b 会话浏览 Esc → 回到启动页（绝不落到对话页）',
    await settled(() => chat.screen().includes('说点什么') && !chat.screen().includes('新建会话')),
    chat.screen().slice(0, 300))
  await chat.unmount()
}

// ── D/J. 参数行四段点开既有选择器（第五版：盖在落地页之上、键盘可达、
//          选完就地更新、Esc 回落地页、草稿不动）────────────────────────────
{
  // 模型段（也是旧 D1 的加强版：不止落地页留着，选择器真的画出来了）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B') // 焦点到参数行第一段（模型）
  await chat.send('\r')
  check('D1 模型段点开 /model 选择器：盖在落地页之上（两屏同帧可见、键盘可达）',
    await settled(() => chat.screen().includes('说点什么')
      && chat.screen().includes('deepseek-reasoner')), chat.screen().slice(0, 300))
  // ↑/↓ 走到另一个模型，Enter 切换：值就地更新、仍停在落地页。
  await chat.send('\u001b[B')
  await chat.send('\r')
  check('D2 选择器里 Enter 切换模型：参数行就地更新（provider 前缀不回来）、落地页不收',
    await settled(() => chat.calls.includes('switch:deepseek/deepseek-reasoner')
      && chat.screen().includes('deepseek-reasoner') && chat.screen().includes('说点什么')),
    JSON.stringify(chat.calls))
  await chat.unmount()
}
{
  // Esc 关选择器回落地页；草稿一字不动。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.type('半句话')
  await chat.send('\u001b[B')
  await chat.send('\r')
  await settled(() => chat.screen().includes('deepseek-reasoner'))
  await chat.send('\x1b')
  check('D3 Esc 关掉选择器回到落地页（半句话草稿原样在）',
    await settled(() => chat.screen().includes('半句话')
      && !chat.screen().includes('deepseek-reasoner')), chat.screen().slice(0, 240))
  // 落地页自己的 Esc 语义不变：有字先清空。
  await chat.send('\x1b')
  check('D4 选择器关掉后落地页 Esc 语义不变（有字先清空、不去看会话）',
    await settled(() => !chat.screen().includes('半句话') && chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  await chat.unmount()
}
{
  // 思考深度段：滑杆选择器（←/→ 即时应用），参数行就地更新。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B')
  await chat.send('\u001b[B') // 第二段 = 思考深度
  await chat.send('\r')
  await settled(() => chat.screen().includes('Max')) // 滑杆的档位表上屏（High/Max 两档）
  await chat.send('\u001b[C') // → 即时应用下一档（max）
  await chat.send('\x1b') // Esc 关滑杆回落地页
  check('J1 思考深度段点开 /effort 滑杆：→ 即时应用、参数行就地更新、Esc 回落地页',
    await settled(() => chat.calls.includes('effort:max')
      && chat.screen().includes('Max') && chat.screen().includes('说点什么')),
    JSON.stringify(chat.calls))
  await chat.unmount()
}
{
  // 模式段（第六版设计 1：agent preset，不是 plan/act）：/preset 选择器，
  // Enter 切到 PTC，参数行就地更新（Standard→PTC）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('Standard'))
  await chat.send('\u001b[B')
  await chat.send('\u001b[B')
  await chat.send('\u001b[B') // 第三段 = 模式（preset）
  await chat.send('\r')
  await settled(() => chat.screen().includes('PTC'))
  await chat.send('\u001b[B') // ↓ 到 PTC（初始焦点在当前 Standard）
  await chat.send('\r')
  check('J2 模式段点开 /preset 选择器：Enter 切 PTC、参数行就地更新（Standard→PTC）',
    await settled(() => chat.calls.includes('preset:ptc')
      && chat.screen().includes('PTC') && chat.screen().includes('说点什么')),
    JSON.stringify(chat.calls))
  await chat.unmount()
}
{
  // 权限段：/permission 选择器（runtime 名册），Enter 换预设、就地更新。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B')
  await chat.send('\u001b[B')
  await chat.send('\u001b[B')
  await chat.send('\u001b[B') // 第四段 = 权限
  await chat.send('\r')
  await settled(() => chat.screen().includes('strict'))
  await chat.send('\u001b[B') // ↓ 到 strict（初始焦点在当前 default）
  await chat.send('\r')
  check('J3 权限段点开 /permission 选择器：Enter 换预设、参数行就地更新（default→strict）',
    await settled(() => chat.calls.some(c => c.startsWith('permission:strict'))
      && chat.screen().includes('说点什么')), JSON.stringify(chat.calls))
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

// ── N. 第六版 BUG 1：命令识别接上 composer 的合并命令表 ──────────────────
{
  // registry 命令（plan 由 dsh-base 注册，不在 LOCAL_COMMANDS）：旧判定
  // isLocalCommandName 认不出它 → 整行 channel.submit 发给模型（用户实测bug）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.type('/plan')
  await chat.send('\r')
  check('N1 registry 命令 /plan 走命令表：plan 选择器盖上来、绝不 submit',
    await settled(() => chat.screen().includes('计划模式') && chat.screen().includes('⌘'))
    && !chat.calls.some(c => c.startsWith('submit:')),
    JSON.stringify(chat.calls))
  await chat.unmount()
}
{
  // 表里没有的 / 开头行与聊天页 Enter 同语义：当普通消息发送（不吞、不静默）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.type('/nosuchcmd')
  // 未知命令没有候选 → 面板本就不开，Enter 直接走提交判定。
  await chat.send('\r')
  check('N2 未知 / 命令当普通消息发送（与聊天页 Enter 同一条 submit 路径）',
    await settled(() => !chat.screen().includes('说点什么'))
    && chat.calls.includes('submit:/nosuchcmd'),
    JSON.stringify(chat.calls))
  await chat.unmount()
}
{
  // 补全面板（第六版 BUG 1）：行首 / 弹面板，Enter 执行选中命令（不 submit）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.type('/pre')
  check('N3 输入 / 弹出命令补全面板（/pre 过滤出 preset）',
    await settled(() => chat.screen().includes('preset')), chat.screen().slice(0, 200))
  await chat.send('\r')
  check('N4 面板选中即执行：/preset 选择器盖在落地页之上（无 submit）',
    await settled(() => chat.screen().includes('PTC') && chat.screen().includes('⌘'))
    && !chat.calls.some(c => c.startsWith('submit:')),
    JSON.stringify(chat.calls))
  await chat.unmount()
}

// ── P. 第六版 BUG 3：选择器点空白关闭、点另一段直接切换 ───────────────────
{
  // 点空白 → 关掉选择器（复用落地页"点空白"兜底：onBlankClick 里 close overlay）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B') // 参数行第一段（模型）
  await chat.send('\r')
  await settled(() => chat.screen().includes('deepseek-reasoner'))
  await chat.click('╭') // 点输入卡片边框（浮层之外的"空白"）
  check('P1 点空白关掉模型选择器（落地页仍在、列表消失）',
    await settled(() => !chat.screen().includes('deepseek-reasoner')
      && chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  await chat.unmount()
}
{
  // 点另一个参数段 → 直接切到那个选择器（不是叠加、不是无反应）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B')
  await chat.send('\r')
  await settled(() => chat.screen().includes('deepseek-reasoner'))
  await chat.click('High') // 参数行的思考深度段
  check('P2 开着模型选择器时点思考深度段：切成 effort 滑杆（且只有一个选择器在屏）',
    await settled(() => !chat.screen().includes('deepseek-reasoner')
      && chat.screen().includes('Max') && chat.screen().includes('说点什么')),
    chat.screen().slice(0, 240))
  await chat.unmount()
}


// ── Q. 第七版：命令面板开 /model、Continue 快捷键、条件位真接线 ────────────
{
  // 面板选中 /model：模型选择器盖在落地页之上，Esc 回**启动页**（回归③）。
  const chat = await mountChat({ launchpadOnBoot: true })
  check('Q0 Q1 夹具挂起来了（落地页上屏）', await settled(() => chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  await chat.type('/model')
  await settled(() => chat.screen().includes('model'))
  await chat.send('\r') // 面板选中 /model → runCommand（不是 submit）
  // 注意：query 还是 '/model'，所以输入行是 ⌘ 前缀（占位不显示）——「落地页
  // 还在」的判据用输入卡片（⌘ /model），不是占位文案。选择器首屏可能是分组
  // 视图（本套件前面的用例写过「最近使用」名册）也可能是模型列表，两个标记
  // 任一在屏即算选择器真的盖了上来。
  check('Q1 面板执行 /model：选择器盖在落地页之上（无 submit）',
    await settled(() => (chat.screen().includes('deepseek-reasoner') || chat.screen().includes('最近使用'))
      && chat.screen().includes('⌘') && chat.screen().includes('/model'))
      && !chat.calls.some(c => c.startsWith('submit:')),
    chat.screen().slice(0, 240))
  await chat.send('\x1b')
  check('Q1b 选择器 Esc → 回到启动页（不是对话页；草稿 /model 原样在）',
    await settled(() => chat.screen().includes('⌘') && chat.screen().includes('/model')
      && !chat.screen().includes('deepseek-reasoner') && !chat.screen().includes('最近使用')),
    chat.screen().slice(0, 240))
  await chat.unmount()
}
{
  // Continue + Alt+R（keymap 的 continue 动作）：agentViewRows 有可继续会话时
  // 入口出现，Alt+R 直接 resumeTo（与点击同一条 runCommand 路径）。
  const rows = [{
    id: 's1', title: '上个会话', current: false, live: false,
    status: 'idle', updatedAt: 2, summary: '',
  }]
  const chat2calls: string[] = []
  const chat = await mountChat({ launchpadOnBoot: true }, {
    agentViewRows: () => rows,
    subscribeAgentView: (fn: () => void) => { fn; return () => {} },
    resumeTo: async (id: string) => { chat2calls.push('resume:' + id); return { ok: true } },
  } as never)
  check('Q2 有可继续会话：Continue 入口带标题出现在入口行第一位',
    await settled(() => chat.screen().includes('继续「上个会话」')),
    chat.screen().slice(0, 200))
  await chat.send('\u001br') // Alt+R
  check('Q2b Alt+R 直接继续那条会话（resumeTo 被调、离开启动页进会话）',
    await settled(() => chat2calls.includes('resume:s1') && !chat.screen().includes('说点什么')),
    JSON.stringify(chat2calls))
  await chat.unmount()
}
{
  // 条件位①：有后台任务在跑 → 第四格是「后台任务」，Enter 打开任务面板
  // （盖在落地页之上），Esc 回启动页。
  const chat = await mountChat({ launchpadOnBoot: true }, {
    backgroundJobs: [{
      id: 'pwsh-1', kind: 'pwsh', label: 'pnpm test', status: 'running',
      startedAt: 1, outputLines: [],
    }],
  } as never)
  check('Q3 有后台任务在跑：条件位显示「后台任务」（优先级①）',
    await settled(() => chat.screen().includes('后台任务') && !chat.screen().includes('帮助')),
    chat.screen().slice(0, 200))
  for (let i = 0; i < 7; i++) await chat.send('\u001b[B') // 第三条入口 = 后台任务
  await chat.send('\r')
  check('Q3b 后台任务入口：任务面板上屏、盖在落地页之上',
    await settled(() => !chat.screen().includes('说点什么') && chat.screen().includes('pnpm test')),
    chat.screen().slice(0, 240))
  await chat.send('\x1b')
  check('Q3c 任务面板 Esc → 回到启动页',
    await settled(() => chat.screen().includes('说点什么')), chat.screen().slice(0, 200))
  await chat.unmount()
}


{
  // 第七版硬约束（澄清版）：从启动页开会话浏览 → **明确选中一个会话** = 有意导航，
  // 必须真的进入那个会话的聊天页（浏览页与落地页都不在屏上）；同场景 Esc 则回
  // 启动页（C1b/C3b 已钉）——两条判据是"选中目标"还是"退出"，不许互相挡。
  const rows = [{
    id: 's9', title: '目标会话', current: false, live: false,
    status: 'idle', updatedAt: 9, summary: '',
  }]
  const q4calls: string[] = []
  const chat = await mountChat({ launchpadOnBoot: true }, {
    agentViewRows: () => rows,
    subscribeAgentView: (fn: () => void) => { fn; return () => {} },
    resumeTo: async (id: string) => { q4calls.push('resume:' + id); return { ok: true } },
  } as never)
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\x1b') // 空输入 Esc → 会话浏览盖在启动页之上
  await settled(() => chat.screen().includes('目标会话'))
  await chat.click('目标会话')
  check('Q4 选中会话 = 有意导航：resumeTo 打开该会话、浏览页与启动页都收掉、落在对话页',
    await settled(() => q4calls.includes('resume:s9')
      && !chat.screen().includes('说点什么') && !chat.screen().includes('目标会话')),
    JSON.stringify(q4calls) + ' :: ' + chat.screen().slice(0, 200))
  await chat.unmount()
}

{
  // 第七版：左下角工作目录铭牌 → 既有 /workspace 菜单盖在落地页之上，Esc 回
  // 落地页（与参数行选择器同一姿态；不新造面板）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.click('C:/code/demo-project')
  check('Q5 点击工作目录铭牌：Workspace 菜单盖在落地页之上（不新造面板）',
    await settled(() => chat.screen().includes('Workspace 操作') && chat.screen().includes('说点什么')),
    chat.screen().slice(0, 240))
  await chat.send('\x1b')
  check('Q5b 菜单 Esc → 回到启动页',
    await settled(() => !chat.screen().includes('Workspace 操作') && chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  await chat.unmount()
}
if (failures === 0) console.log(`\nverify-launchpad-onboarding-chat: ${checks} checks, all passed`)
else console.error(`\nverify-launchpad-onboarding-chat: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)