/**
 * verify-launchpad-onboarding-chat — launchpad and onboarding flows through Chat.
 *
 * Covers overlays, draft submission, onboarding persistence, model/effort/preset/
 * permission selection, command completion and recovery mounting.
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
 *   R. AC-4 的**真集成面**：长名 preset 载荷 → 真 SGR motion 悬停到被截断的
 *      preset 段 → 卡片显示完整名 → 指针移开卡片消失。这一组钉的是 `Chat.tsx`
 *      落地页分支末尾那一行 `<TooltipLayer />`——删掉它 R1 必红（F-01 的守卫；
 *      verify-launchpad 的 S 组是孤立夹具自挂层，删 Chat 那一行那边照绿）。
 *
 *
 * Run: node --import tsx/esm scripts/verify-launchpad-onboarding-chat.tsx
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
  { noteBoundaryRecoveryRemount },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/minimalUiMode.js'),
  import('../src/onboardingPrefs.js'),
  import('../src/dsh-adapter/plugin.js'),
  import('../src/ink/update-overflow-guard.js'),
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
 * Chat reads only the channel surface needed to render these flows.
 * Mutable settings and subscriptions let picker changes redraw the screen.
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
    // 配置 provider，使动作表显示正常入口而非 provider 设置入口。
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
    // 能力事实（端口新增：AgentCapabilities）：桩 channel 必须实现，否则
    // Chat 的命令分支（/plan、/compact）读不到路由。与上面的 commandList
    // 同源：plan 由 registry 提供，compact 走 TUI 自己的事务。
    capabilities: () => ({
      compact: { route: 'local' },
      plan: { route: 'registry' },
      compaction: true,
      pruner: true,
      questionTool: true,
      skills: true,
    }),
    // 命令补全面板与 composer 共用 completeCommands 过滤器和命令表。
    commandCompletions: (input: string) => completeCommands(input, channel.commandList as never) as never,
    // 参数行的模式段显示 agent preset 名称。
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
    // Settings 整屏只需要这三条接口；host
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

async function mountChat(flags: Flags, over: Record<string, unknown> = {}, chatProps: Record<string, unknown> = {}) {
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
          // 宿主注入的缝（内核选择器等）：用例按需补，缺省与真机之外的
          // headless 宿主一致（没有这些能力时 Chat 只提示、不假装）。
          {...chatProps}
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
  return { term, stdout, stdin, channel, notifications, calls, screen, send, type, click, unmount: async () => { await instance.unmount() } }
}

const LAUNCHPAD_MARK = '说点什么，或输入 /' + ' 看命令…'
const WIZARD_MARK = '第 1 / 4 步'
/** 帮助盖屏的标记：HelpMenu 快捷键列头与命令区标题。 */
const HELP_MARK = '? 查看本帮助'
/**
 * 模型选择器「展开」的双标记：套件前面的用例（D2/Q1）切过模型 →
 * modelRecents 落盘 → 之后 /model 首屏可能是「最近使用」分组视图而非
 * 模型列表（Q1 同款口径）。
 */
const modelOpen = (screen: string): boolean =>
  screen.includes('deepseek-reasoner') || screen.includes('最近使用')
const HELP_COMMANDS_MARK = '命令：'
/**
 * 参数行（值 + 双空格·双空格 分隔）里某段的终端坐标：浮层（选择器/滑杆）
 * 展开时屏上会出现同名词（模型列表里的当前模型、滑杆档位表里的 High……），
 * findCell 取首个命中会点进浮层。这里先定位含分隔符的参数行，再在该行内
 * 找目标值——点的一定是参数段本身。
 */
function findParamCell(term: InstanceType<typeof XTerm>, value: string): { col: number; row: number } | null {
  const lines = viewportLines(term)
  // 参数行在输入卡片**下方**，而盖屏浮层在卡片上方展开——取**最后一个**
  // 匹配行（选择器/滑杆自己的行也可能用 · 分隔，它们都在参数行上方）。
  for (let row = lines.length - 1; row >= 0; row--) {
    const line = lines[row]!
    if (!line.includes('  \u00b7  ')) continue
    const at = line.indexOf(value)
    if (at >= 0) return { col: stringWidth(line.slice(0, at)) + 1, row: row + 1 }
  }
  return null
}
/**
 * 先定位含 rowNeedle 的行，再在该行内找 needle（SGR 鼠标用）：帮助盖屏里有
 * 「? 查看本帮助」，整屏首中会点进浮层而不是入口行的「帮助」chip。
 */
function findCellInRow(term: InstanceType<typeof XTerm>, rowNeedle: string, needle: string): { col: number; row: number } | null {
  const lines = viewportLines(term)
  for (const line of lines) {
    if (!line.includes(rowNeedle)) continue
    const at = line.indexOf(needle)
    if (at >= 0) return { col: stringWidth(line.slice(0, at)) + 1, row: lines.indexOf(line) + 1 }
  }
  return null
}
/** 点击入口行的某个 chip（等它上屏后按行定位再点）。 */
async function clickChip(chat: { term: unknown; stdout: { frames: unknown[] }; stdin: { write: (d: string) => void } }, needle: string): Promise<void> {
  await settled(() => findCellInRow(chat.term as InstanceType<typeof XTerm>, '会话与工作区', needle) !== null)
  const cell = findCellInRow(chat.term as InstanceType<typeof XTerm>, '会话与工作区', needle)
  if (cell === null) throw new Error('chip not on entry row: ' + needle)
  const before = chat.stdout.frames.length
  chat.stdin.write('\u001b[<0;' + cell.col + ';' + cell.row + 'M\u001b[<0;' + cell.col + ';' + cell.row + 'm')
  await settle(() => chat.stdout.frames.length > before, { timeoutMs: 400 })
}
/** 启动页大字行（含 █ 的行）快照——「原样恢复」断言的比较基线。 */
const heroLines = (screen: string): string[] =>
  screen.split('\n').filter(l => l.includes('█')).map(l => l.replace(/\s+$/u, ''))
const heroIdentical = (before: readonly string[], after: readonly string[]): boolean =>
  before.length > 0 && after.length === before.length
  && before.every((l, i) => l === after[i])

// ── A. /setup 打开向导 ─────────────────────────────────────────────────────
{
  const chat = await mountChat({ launchpadOnBoot: true })
  check('A1 普通启动落在落地页', await settled(() => chat.screen().includes('说点什么')))
  await chat.type('/setup')
  await chat.send('\r')
  check('A2 落地页里 /setup 打开向导（向导盖在落地页之上）',
    await settled(() => chat.screen().includes(WIZARD_MARK) && !chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  // Esc 跳过向导后回到落地页。
  // 草稿 '/setup' 还在输入框里（前缀 ⌘）——落地页状态原样保留。
  await chat.send('\x1b')
  check('A2b 向导 Esc 跳过回到落地页（不是对话页；草稿 /setup 原样在）',
    await settled(() => chat.screen().includes('⌘') && chat.screen().includes('/setup')
      && !chat.screen().includes(WIZARD_MARK)),
    chat.screen().slice(0, 200))
  await chat.unmount()
}

// ── B. 提交首句 ──
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
  // 「工作区」是落地页入口 chip 的残留敏感子串（视口下半残帧会偶发留它一拍）；
  // 判据换成浏览页自己的「新建会话」行——语义不变（浏览器不上屏），不碰残帧。
  check('B3 也不再显示会话浏览器（首句刚发进眼前的对话里）',
    await settled(() => !chat.screen().includes('新建会话')), chat.screen().slice(0, 240))
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
  // /help 的帮助浮层盖在启动页之上，不切换到对话页，也不触发 submit。
  check('B6 命令行走命令表：不触发 channel.submit（本地命令不发模型）',
    await settled(() => chat.screen().includes(HELP_MARK) && chat.screen().includes('⌘'))
      && !chat.calls.some(c => c.startsWith('submit:')),
    chat.screen().slice(0, 240))
  await chat.send('\x1b')
  check('B6b /help 盖屏 Esc → 回到启动页（草稿 /help 原样在、聊天页不上屏）',
    await settled(() => !chat.screen().includes(HELP_MARK)
      && chat.screen().includes('⌘') && chat.screen().includes('/help')),
    chat.screen().slice(0, 240))
  await chat.unmount()
}

// ── C. 会话管理与设置入口 ──
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
  // 从启动页打开会话浏览后按 Esc，必须回到启动页。
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

// ── D/J. 参数选择器与键盘路径（覆盖层显示时启动页保持可见，选择后更新参数并保留草稿） ──
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
  check('D3a 关闭前模型选择器确实展开',
    await settled(() => modelOpen(chat.screen())), chat.screen().slice(0, 240))
  await chat.send('\x1b')
  check('D3 Esc 关掉选择器回到落地页（半句话草稿原样在）',
    await settled(() => chat.screen().includes('半句话')
      && !modelOpen(chat.screen()) && chat.screen().includes('● Tips：')), chat.screen().slice(0, 240))
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
  // 模式段打开 /preset 选择器，Enter 切换到 PTC 并更新参数行。
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
//      工作区目标不参与普通启动判定） ──
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

// ── N. 命令识别与补全 ──
{
  // registry 命令 plan 由 dsh-base 注册，不在 LOCAL_COMMANDS；若当作普通消息会发给模型。
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
  // 行首 / 打开补全面板，Enter 执行选中命令，不调用 submit。
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

// ── P. 选择器的空白关闭与段间切换 ──
{
  // 点空白 → 关掉选择器（复用落地页"点空白"兜底：onBlankClick 里 close overlay）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B') // 参数行第一段（模型）
  await chat.send('\r')
  check('P1a 点空白前模型选择器确实展开',
    await settled(() => modelOpen(chat.screen())), chat.screen().slice(0, 240))
  await chat.click('╭') // 点输入卡片边框（浮层之外的"空白"）
  check('P1 点空白关掉模型选择器（落地页仍在、列表消失）',
    await settled(() => !modelOpen(chat.screen())
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
  check('P2a 切换参数段前模型选择器确实展开',
    await settled(() => modelOpen(chat.screen())), chat.screen().slice(0, 240))
  await chat.click('High') // 参数行的思考深度段
  check('P2 开着模型选择器时点思考深度段：切成 effort 滑杆（且只有一个选择器在屏）',
    await settled(() => !modelOpen(chat.screen())
      && chat.screen().includes('Max') && chat.screen().includes('说点什么')),
    chat.screen().slice(0, 240))
  await chat.unmount()
}


// ── T. 参数段点击可切换展开状态 ──
{
  // 四段各一条：点开 → 再点同一段 → 关；关掉后启动页原样恢复（浮层矩形
  // 不留痕、无重影——大字行内容逐字节一致）。
  const cases: { label: string; value: string; open: (screen: string) => boolean }[] = [
    { label: '模型', value: 'deepseek-chat', open: modelOpen },
    { label: '思考深度', value: 'High', open: (s: string): boolean => s.includes('Max') },
    { label: '模式', value: 'Standard', open: (s: string): boolean => s.includes('PTC') },
    { label: '权限', value: 'default', open: (s: string): boolean => s.includes('strict') },
  ]
  for (const { label: seg, value, open } of cases) {
    const chat = await mountChat({ launchpadOnBoot: true })
    await settled(() => chat.screen().includes('说点什么'))
    const heroBefore = heroLines(chat.screen())
    // 点段 = 展开（SGR 鼠标点击，坐标取参数行里的段本身，见 findParamCell）。
    await settled(() => findParamCell(chat.term, value) !== null)
    const cell = findParamCell(chat.term, value)
    if (cell === null) throw new Error('param segment not on screen: ' + value)
    const before = chat.stdout.frames.length
    chat.stdin.write('\u001b[<0;' + cell.col + ';' + cell.row + 'M\u001b[<0;' + cell.col + ';' + cell.row + 'm')
    await settle(() => chat.stdout.frames.length > before, { timeoutMs: 400 })
    check('T1[' + seg + '] 点击段展开选择器（浮层标记上屏、启动页仍在）',
      await settled(() => open(chat.screen()) && chat.screen().includes('说点什么')),
      chat.screen().slice(0, 240))
    // 再点同一段 = 收起（切换式；不是无反应、不是叠加）。固定窗:pacing —
    // 鼠标层把同格 500ms 内的二连击当双击（选词）吞掉，这里隔开双击窗口。
    await new Promise(resolve => setTimeout(resolve, 550))
    const cell2 = findParamCell(chat.term, value)
    if (cell2 === null) throw new Error('param segment vanished: ' + value)
    const before2 = chat.stdout.frames.length
    chat.stdin.write('\u001b[<0;' + cell2.col + ';' + cell2.row + 'M\u001b[<0;' + cell2.col + ';' + cell2.row + 'm')
    await settle(() => chat.stdout.frames.length > before2, { timeoutMs: 400 })
    check('T2[' + seg + '] 再点同一段收起（浮层消失、仍停在启动页）',
      await settled(() => !open(chat.screen()) && chat.screen().includes('说点什么')),
      chat.screen().slice(0, 240))
    check('T3[' + seg + '] 关闭后启动页原样恢复（大字行逐字节一致、无重影）',
      heroIdentical(heroBefore, heroLines(chat.screen())),
      JSON.stringify({ before: heroBefore.length, after: heroLines(chat.screen()).length }))
    await chat.unmount()
  }
}
{
  // 键盘路径：焦点落到段上 Enter = 展开；Esc 收起后再 Enter = 再展开
  //（展开 ↔ 收起可重复，键盘与鼠标同一条 onParamPick）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\u001b[B') // 焦点到模型段
  await chat.send('\r')
  check('T4 键盘 Enter 展开模型选择器', await settled(() => modelOpen(chat.screen())))
  await chat.send('\x1b')
  check('T4b Esc 收起选择器回启动页', await settled(() => !modelOpen(chat.screen())
    && chat.screen().includes('说点什么')))
  // Esc 只收浮层、焦点仍在模型段——直接 Enter 即再次展开（同一格展开 ↔ 收起）。
  await chat.send('\r')
  check('T4c 收起后键盘 Enter 可再次展开（切换可重复）',
    await settled(() => modelOpen(chat.screen()) && chat.screen().includes('说点什么')))
  await chat.unmount()
}

// ── V. 帮助入口显示覆盖层 ──
{
  // ① 点帮助 → 帮助盖在启动页之上（聊天页不上屏、启动页仍在）；
  // ② Esc → 关闭回启动页（草稿/参数/焦点都在）；
  // 再点帮助 → 再次盖屏；盖屏开着时再点帮助 = 收起（入口自身也是切换式）。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await chat.type('半句草稿')
  await clickChip(chat, '帮助')
  // 「启动页仍在」的判据：参数行（Standard 段）与 Tips 行还在屏上（草稿
  // 顶掉了输入占位符，不能用「说点什么」）。
  check('V1 点帮助：帮助盖屏上屏、聊天页不上屏、启动页仍在（两屏同帧）',
    await settled(() => chat.screen().includes(HELP_MARK) && chat.screen().includes(HELP_COMMANDS_MARK)
      && chat.screen().includes('Standard') && chat.screen().includes('● Tips：')
      && !chat.screen().includes('新建会话')),
    chat.screen().slice(0, 240))
  check('V1b 帮助盖屏期间不触发 submit（不是发消息）',
    !chat.calls.some(c => c.startsWith('submit:')), JSON.stringify(chat.calls))
  await chat.send('\x1b')
  check('V2 Esc 关闭帮助 → 回到启动页（草稿原样在）',
    await settled(() => !chat.screen().includes(HELP_MARK)
      && chat.screen().includes('半句草稿') && chat.screen().includes('● Tips：')),
    chat.screen().slice(0, 240))
  // 固定窗:pacing — 与 V1 的点击隔开鼠标层的双击窗口（500ms/同格），否则
  // 第二次点击被当双击选词吞掉、到不了入口的 onClick。
  await new Promise(resolve => setTimeout(resolve, 550))
  await clickChip(chat, '帮助')
  check('V3 再点帮助 → 再次盖屏（可重复）',
    await settled(() => chat.screen().includes(HELP_MARK) && chat.screen().includes('● Tips：')))
  await new Promise(resolve => setTimeout(resolve, 550))
  await clickChip(chat, '帮助')
  check('V4 盖屏开着时再点帮助入口 = 收起（切换式，回启动页）',
    await settled(() => !chat.screen().includes(HELP_MARK) && chat.screen().includes('● Tips：')),
    chat.screen().slice(0, 240))
  await chat.unmount()
}
{
  // 盖屏里点命令行 = 填进落地页草稿（Tab 补全的鼠标等价），人还在启动页。
  const chat = await mountChat({ launchpadOnBoot: true })
  await settled(() => chat.screen().includes('说点什么'))
  await clickChip(chat, '帮助')
  await settled(() => chat.screen().includes(HELP_MARK))
  // 命令列在 15 行视口里会截断——点必在屏的首行 /new。
  await chat.click('/new')
  check('V5 帮助里点命令行：填入 /new 草稿、盖屏收起、仍在启动页',
    await settled(() => !chat.screen().includes(HELP_MARK)
      && chat.screen().includes('⌘') && chat.screen().includes('/new')),
    chat.screen().slice(0, 240))
  await chat.unmount()
}

// ── W. 覆盖层显示期间启动页保持稳定 ──
{
  // 无头挂真实 Chat（boot 标志）后，跨 ~1.1s 多次采样：启动页一直在屏上
  // （不是只看第一帧），且没有任何整屏被异步打开顶掉它（无浏览器/向导/
  // 任务面板标记）。固定窗: 本用例的时间断言（1.1s 采样窗）是契约本体
  // ——用户实测的 bug 是异步状态在首帧之后才把落地页顶掉。
  const chat = await mountChat({ launchpadOnBoot: true, openHomeOnBoot: true })
  check('W0 首帧在启动页', await settled(() => chat.screen().includes('说点什么')))
  const deadline = Date.now() + 1100
  let stillThere = true
  let noCover = true
  let samples = 0
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150)) // 固定窗: 150ms 采样间隔
    samples += 1
    const screen = chat.screen()
    if (!screen.includes('说点什么')) stillThere = false
    if (screen.includes('新建会话') || screen.includes(WIZARD_MARK) || screen.includes('pnpm test')) noCover = false
  }
  check('W1 启动页跨 1s / 多次 settle 仍在屏上（不只是一帧）',
    stillThere && samples >= 5, 'samples=' + samples)
  check('W2 期间没有任何整屏被异步打开顶掉它', noCover)
  await chat.unmount()
}

// ── Q. 命令面板与入口动作 ──
{
  // 面板选中 /model 后，选择器盖在落地页上，Esc 返回启动页。
  const chat = await mountChat({ launchpadOnBoot: true })
  check('Q0 Q1 夹具挂起来了（落地页上屏）', await settled(() => chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  // 关掉浮层后，启动页与大字行逐字节恢复。
  const heroBefore = chat.screen().split('\n').filter(l => l.includes('█'))
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
  {
    const heroAfter = chat.screen().split('\n').filter(l => l.includes('█'))
    // 行尾的重绘空白（ink 只写有变化的格子，被浮层擦过的尾格补成空格）不算
    // 内容差异——判「内容逐字节一致」：trimEnd 后完全相等、行数不变。
    const heroBeforeT = heroBefore.map(l => l.replace(/\s+$/u, ''))
    const heroAfterT = heroAfter.map(l => l.replace(/\s+$/u, ''))
    const diffIndex = heroAfterT.findIndex((l, i) => l !== heroBeforeT[i])
    check('Q1c 关掉浮层后启动页原样恢复（大字行内容逐字节一致，无残留字形/空缺）',
      heroBefore.length > 0 && heroAfter.length === heroBefore.length && diffIndex === -1,
      `firstDiff@${diffIndex}: ${JSON.stringify(heroBeforeT[diffIndex])} -> ${JSON.stringify(heroAfterT[diffIndex])}`)
  }
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
  for (let i = 0; i < 8; i++) await chat.send('\u001b[B') // 条件位（第五格）= 后台任务；内核入口插入后多一格
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
  // 明确选择会话表示有意导航，必须进入该会话的聊天页；同一浏览页按 Esc 则返回启动页。
  const rows = [{
    id: 's9', title: '目标会话', current: false, live: false,
    status: 'idle', updatedAt: 9, summary: '',
  }]
  const q4calls: string[] = []
  // 浏览页的名册吃 channel 的会话列表（listSessions/cachedSessions），不是
  // agentViewRows——给它一条真会话（快照首帧即上屏），点击点的是**真行**，
  // 不再靠视口残留碰巧落在入口上（偶发红的根因）。
  const summary = {
    id: 's9', kind: { kind: 'root' as const }, title: { text: '目标会话', source: 'renamed' as const },
    cwd: 'C:/code/demo-project', createdAt: 1, updatedAt: 9, bytes: 10, hasPrompt: true,
    agentPreset: undefined, model: undefined,
  }
  const chat = await mountChat({ launchpadOnBoot: true }, {
    agentViewRows: () => rows,
    subscribeAgentView: (fn: () => void) => { fn; return () => {} },
    cachedSessions: () => [summary],
    listSessions: () => Promise.resolve([summary]),
    resumeTo: async (id: string) => { q4calls.push('resume:' + id); return { ok: true } },
  } as never)
  await settled(() => chat.screen().includes('说点什么'))
  await chat.send('\x1b') // 空输入 Esc → 会话浏览盖在启动页之上
  // 等**名册落定**（计数行从「共 0」变「共 1」、行真的画出来）再点——
  // 刷新窗口内点击会与 listSessions 重放竞态，偶发点了不关。
  await settled(() => chat.screen().includes('共 1'))
  await settled(() => chat.screen().includes('目标会话'))
  await chat.click('目标会话')
  check('Q4 选中会话 = 有意导航：resumeTo 打开该会话、浏览页与启动页都收掉、落在对话页',
    await settled(() => q4calls.includes('resume:s9')
      && !chat.screen().includes('说点什么') && !chat.screen().includes('目标会话')),
    JSON.stringify(q4calls) + ' :: ' + chat.screen().slice(0, 200))
  await chat.unmount()
}

{
  // 左下角工作目录铭牌打开现有 /workspace 菜单，Esc 返回启动页。
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
// ── X. 内核选择器（用户实测：点「内核」直接落进对话页，没有选择空间）──────
{
  // 组合根注入的两条缝：onProbeKernels（Claude 探测）与 onSwitchBackend
  // （写记忆 + 重启进入新内核）。这一段的断言就是用户报的那条链路：
  // 点「内核」→ 选择器盖在启动页之上 → 选 Claude → 真的调了切换。
  const switches: string[] = []
  let probes = 0
  const chat = await mountChat(
    { launchpadOnBoot: true },
    {},
    {
      onSwitchBackend: (id: string) => { switches.push(id) },
      onProbeKernels: async () => { probes += 1; return { claude: { installed: true, auth: 'ok' as const, version: '2.1.284' } } },
    },
  )
  check('X0 夹具挂起来了（启动页上屏）', await settled(() => chat.screen().includes('说点什么')), chat.screen().slice(0, 200))
  // 右下角：可选内核行 + 当前内核的箭头标记（用户原话「有箭头或者高亮
  // 表明目前记忆中启动的内核」）。
  check('X1 右下角列出可选内核，当前内核带 ▸ 标记',
    await settled(() => /▸\s*DSH/.test(chat.screen()) && chat.screen().includes('Claude ·')),
    chat.screen().slice(-320))
  check('X2 Claude 行显示探测到的版本（claude-code v…）',
    await settled(() => chat.screen().includes('claude-code v2.1.284')),
    'probes=' + probes + ' :: ' + chat.screen().slice(-320))
  check('X2b 探测只跑一次（组合根那条缝不会被反复打）', probes === 1, 'probes=' + probes)
  await clickChip(chat, '内核')
  check('X3 点「内核」：选择器盖在启动页之上（启动页仍在、没落进对话页）',
    await settled(() => chat.screen().includes('选择内核') && chat.screen().includes('说点什么')),
    chat.screen().slice(0, 360))
  check('X4 选择器里两行内核都在（DSH 当前、Claude 可选）',
    await settled(() => chat.screen().includes('DeepSeek Harness') && chat.screen().includes('Claude Agent')),
    chat.screen().slice(0, 360))
  await chat.click('Claude Agent')
  check('X5 选中 Claude：走组合根 onSwitchBackend(claude)（不是落进 DSH 对话页）',
    await settled(() => switches.includes('claude')),
    JSON.stringify(switches))
  await chat.unmount()
}
{
  // Esc 关掉选择器：谁也不切（切换是显式动作，误开一次不会换内核）。
  const switches: string[] = []
  const chat = await mountChat({ launchpadOnBoot: true }, {}, {
    onSwitchBackend: (id: string) => { switches.push(id) },
    // 探测说「没装」：那一行必须画灰并写明原因。
    onProbeKernels: async () => ({ claude: { installed: false } }),
  })
  await settled(() => chat.screen().includes('说点什么'))
  await clickChip(chat, '内核')
  await settled(() => chat.screen().includes('选择内核'))
  await chat.send('\x1b')
  check('X6 Esc 关掉选择器回启动页，且没有发生任何切换',
    await settled(() => !chat.screen().includes('选择内核') && chat.screen().includes('说点什么')) && switches.length === 0,
    JSON.stringify(switches))
  // 浮层关闭后，本夹具里的第一次鼠标点击会被吞掉——**A/B 实证**：换成帮助入口
  // 也一样（helpFirst=true / helpAfterEsc=false），而帮助走的是同一条
  // ActionChip.onClick，所以这是夹具在浮层关闭后的鼠标节奏问题，不是内核入口
  // 特有的缺陷；上面的 V 段同样用这个 550ms 停顿规避。照既有做法，不把夹具的
  // 脾气写成产品 bug，也不放宽断言——这里点的仍然是**一次**单击。
  await new Promise(resolve => setTimeout(resolve, 550))
  await clickChip(chat, '内核')
  check('X7 关闭后能再次打开选择器（同一个入口可重复用）',
    await settled(() => chat.screen().includes('选择内核'), { timeoutMs: 1200 }),
    chat.screen().slice(0, 360))
  check('X7b 未安装的 Claude 行写明原因（未安装）',
    await settled(() => chat.screen().includes('未安装')),
    chat.screen().slice(0, 360))
  // 键盘路径：↓ 移到不可选行 + Enter = 只提示原因，绝不切换（选择器留在屏上）。
  const beforeKeys = chat.screen().slice(-300)
  await chat.send('\x1b[B')
  const afterDown = chat.screen().slice(-300)
  await chat.send('\r')
  const afterEnter = chat.screen().slice(-300)
  check('X8a ↓/Enter 之后选择器仍在屏上（不可选行不吃掉 Enter）',
    chat.screen().includes('选择内核'),
    'before=' + JSON.stringify(beforeKeys) + '\n      down=' + JSON.stringify(afterDown)
      + '\n      enter=' + JSON.stringify(afterEnter))
  check('X8 在不可选行上 Enter：提示原因、不切换、选择器不收起',
    await settled(() => chat.notifications.some(text => text.includes('未安装')))
      && switches.length === 0 && chat.screen().includes('选择内核'),
    'before=' + JSON.stringify(beforeKeys) + '\n      down=' + JSON.stringify(afterDown)
      + '\n      enter=' + JSON.stringify(afterEnter) + '\n      notes=' + JSON.stringify(chat.notifications))
  await chat.send('\x1b')
  await chat.unmount()
}
{
  // 回合运行中（例如后台任务唤醒了模型）切内核会杀掉这个回合：只提示，不切换。
  const switches: string[] = []
  const chat = await mountChat({ launchpadOnBoot: true }, { working: true }, {
    onSwitchBackend: (id: string) => { switches.push(id) },
    onProbeKernels: async () => ({ claude: { installed: true, auth: 'ok' as const, version: '2.1.284' } }),
  })
  await settled(() => chat.screen().includes('说点什么'))
  await clickChip(chat, '内核')
  await settled(() => chat.screen().includes('选择内核') && chat.screen().includes('claude-code v2.1.284'))
  await chat.click('Claude Agent')
  check('X9 回合运行中选 Claude：提示不能切换，不调用 onSwitchBackend',
    await settled(() => chat.notifications.includes('回合运行中，无法切换内核')) && switches.length === 0,
    JSON.stringify({ switches, notes: chat.notifications }))
  await chat.send('\x1b')
  await chat.unmount()
}
{
  // /channel 打开后回合开始了（后台任务唤醒模型）：换到连接不同的渠道要以新
  // 会话重启，会打断这个回合，所以只提示，不写渠道、不重启。
  const sets: string[] = []
  const restarts: string[] = []
  const conn = (url: string) => ({ baseUrl: url, hasToken: true, envKeys: [], fingerprint: url })
  const channels = [
    { id: 'alpha', name: 'alpha', models: [], tiers: [], connection: conn('https://alpha.example') },
    { id: 'beta', name: 'beta', models: [], tiers: [], connection: conn('https://beta.example') },
  ]
  const chat = await mountChat({}, {
    commandList: [...LOCAL_COMMANDS, { name: 'channel', description: 'channel' }],
    backendChannels: () => ({
      snapshot: () => ({ channels, activeId: 'alpha' }),
      activate: (id: string) => {
        if (chat.channel.working) {
          chat.channel.notify('回合运行中，无法切换或改动渠道')
          return { ok: false, restart: true }
        }
        sets.push(id)
        return { ok: true, restart: true }
      },
      importFromSettings: () => undefined,
      save: () => undefined,
      remove: () => false,
      peekImport: () => undefined,
    }),
  }, { onRestartFreshSession: (notice: string) => { restarts.push(notice) } })
  await chat.type('/channel')
  await chat.send('\r')
  check('X10 /channel 打开渠道选择器',
    await settled(() => chat.screen().includes('渠道档案') && chat.screen().includes('beta')),
    chat.screen().slice(-600))
  ;(chat.channel as { working: boolean }).working = true
  await chat.send('\x1b[B')
  // 固定窗:墙钟 Chat 吞掉上一次 Enter 后 80ms 内的回车（防连按），等过这个窗口。
  await new Promise(resolve => setTimeout(resolve, 120))
  await chat.send('\r')
  check('X10b 回合运行中切到连接不同的渠道：提示、不写渠道、不重启',
    await settled(() => chat.notifications.includes('回合运行中，无法切换或改动渠道'))
      && sets.length === 0 && restarts.length === 0,
    JSON.stringify({ sets, restarts, notes: chat.notifications }))
  ;(chat.channel as { working: boolean }).working = false
  // 固定窗:墙钟 同上，越过回车防连按窗口。
  await new Promise(resolve => setTimeout(resolve, 120))
  await chat.send('\r')
  check('X10c 空闲后同一操作：写渠道并以新会话重启',
    await settled(() => sets.join() === 'beta' && restarts.length === 1),
    JSON.stringify({ sets, restarts, notes: chat.notifications }))
  await chat.unmount()
}

// ── Y. claude 内核的启动页编排（用户实测：kernel.json 记住 claude 后全新启动
//      直接进聊天页、没有启动页。修复后 launchpadOnBoot 不再看后端——claude
//      启动同样先落启动页、Enter 才进聊天；带 resume 目标仍直达）─────────────
{
  // 桩口径与真机 claude 会话一致：backendCapabilities.backendId = 'claude'
  // （Chat 的 kernelCurrentId 只认这一处——右下角内核区的 ▸ 与入口名都跟着它）。
  const claudeCaps = { backendId: 'claude', backendLabel: 'Claude', commands: [] }
  const chat = await mountChat({ launchpadOnBoot: true }, { backendCapabilities: claudeCaps })
  check('Y1 claude 内核全新启动先落启动页（Launchpad 盖在最上层）',
    await settled(() => chat.screen().includes('说点什么')), chat.screen().slice(0, 200))
  check('Y2 内核角标把 claude 记为当前内核（▸ 在 Claude 行，不在 DSH 行）',
    await settled(() => /▸\s*Claude/.test(chat.screen()) && !/▸\s*DSH/.test(chat.screen())),
    chat.screen().slice(-320))
  await chat.type('你好')
  await chat.send('\r')
  check('Y3 Enter 发首条消息才进聊天页（与 dsh 路径同一条 submit）',
    await settled(() => !chat.screen().includes('说点什么')) && chat.calls.includes('submit:你好'),
    JSON.stringify(chat.calls))
  await chat.unmount()
}
{
  // resume 目标（DSH_TUI_RESUME_SESSION / --resume <id>，plugin 侧同源的
  // launchSessionId）仍直达会话：noResume 门保留，与后端无关。
  const chat = await mountChat({}, { backendCapabilities: { backendId: 'claude', backendLabel: 'Claude', commands: [] } })
  check('Y4 resume 启动直达聊天页（没有启动页盖屏）',
    await settled(() => !chat.screen().includes('说点什么')),
    chat.screen().slice(0, 200))
  await chat.unmount()
}



// ── R. 错误边界恢复重挂的落点矩阵：recovery 标志会压下所有启动入口，恢复后回到对话页且只消费一次。 ──
/**
 * 固定窗:探针 观察窗内不得出现任何启动入口屏。会话管理屏的内容（工作区/会话
 * 列表）是异步解析后才上屏的，一次读屏会跑到它前面——坏基线上假绿（实测）。
 * 轮询整窗，任一标记出现即判失败，窗内未现才算通过。
 */
async function noBootSurfaceFor(chat: { screen: () => string }, windowMs: number): Promise<string | null> {
  const deadline = Date.now() + windowMs
  for (;;) {
    const screen = chat.screen()
    for (const mark of ['说点什么', WIZARD_MARK, '新建会话']) {
      if (screen.includes(mark)) return mark
    }
    if (Date.now() >= deadline) return null
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

{
  const combos: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, false],
    [false, false, true],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ]
  let matrixOk = true
  let note = ''
  let index = 0
  for (const [openHome, launchpad, onboarding] of combos) {
    index += 1
    noteBoundaryRecoveryRemount()
    const chat = await mountChat({ openHomeOnBoot: openHome, launchpadOnBoot: launchpad, onboardingOnBoot: onboarding })
    const offender = await noBootSurfaceFor(chat, 1200)
    await chat.unmount()
    if (offender !== null) {
      matrixOk = false
      note = 'combo #' + index + ' openHome=' + openHome + ' launchpad=' + launchpad + ' onboarding=' + onboarding + ' -> ' + offender
      break
    }
  }
  check('R1 recovery × 全部 8 种启动组合：恢复落点都是对话页（无启动页/向导/会话管理）', matrixOk, note)

  // 标志只消费一次：恢复挂载吃掉标记后，紧接着的普通挂载回到正常语义
  // （openHome=true × launchpad=false 仍预开会话管理屏）。
  noteBoundaryRecoveryRemount()
  const recoveryChat = await mountChat({ openHomeOnBoot: true, launchpadOnBoot: false })
  const recoveryOffender = await noBootSurfaceFor(recoveryChat, 1200)
  check('R2 恢复挂载本身落在对话页（观察窗内无任何启动入口）', recoveryOffender === null, String(recoveryOffender))
  await recoveryChat.unmount()
  const plainChat = await mountChat({ openHomeOnBoot: true, launchpadOnBoot: false })
  await settled(() => plainChat.screen().includes('新建会话'))
  check('R3 标志只消费一次：下一个普通挂载仍按 openHome 预开会话管理屏', plainChat.screen().includes('新建会话'), plainChat.screen().slice(0, 160))
  await plainChat.unmount()
}
// ── R. AC-4 的真集成面：Chat 挂的那层 TooltipLayer 真的把卡片画出来 ──────────
// REVIEW F-01：S 组（verify-launchpad）是**孤立夹具自挂单例层**，本脚本此前 0 处
// tooltip 断言 ⇒ 把 `Chat.tsx` 落地页分支末尾的 `<TooltipLayer />` 删掉，
// `verify:build` 4/4 + 258 + 77 仍全绿（覆盖率幻觉）。这一组钉**真 Chat 树**上的
// 端到端面：长名 preset 载荷（参数行装不下 ⇒ preset 段真的被尾部截断）→ 真 SGR
// mode-1003 motion 悬停到**被截断的 preset 段**（列号按显示宽度算，与 S 组同法）
// → 轮询到屏上出现**完整 preset 名** → 指针移开卡片消失。
const AC4_FULL_PRESET = 'Standard (Git Bash · official tooling)'
/** 被截断的 preset 段在屏上的前缀（`truncateToWidth` 之后的头部，卡片出现前屏上只有它）。 */
const AC4_CUT_PRESET = 'Standard (Git Bash'
{
  const chat = await mountChat({ launchpadOnBoot: true }, {
    // 名册是异步预热的（Chat 的 effect 读 listPresets）：把当前 preset 的显示名
    // 换成 AC-1 同款 38 格长名，参数行（预算 70 格）就装不下它。
    agentPreset: 'standard',
    listPresets: async () => [
      { id: 'standard', name: AC4_FULL_PRESET, isDefault: true },
      { id: 'ptc', name: 'PTC', isDefault: false },
    ],
  } as never)
  // 名册落定：被截断的 preset 段上屏（带 `…`），且**完整名还不在屏上**——
  // 后者是这一组的基线：卡片出现之前，完整名不可能靠别的路径上屏。
  const cutOnScreen = await settled(() => {
    const line = viewportLines(chat.term).find(l => l.includes(AC4_CUT_PRESET))
    return line !== undefined && line.includes('…')
  })
  const beforeHover = chat.screen()
  const cell = findParamCell(chat.term, AC4_CUT_PRESET)
  if (cell === null) throw new Error('truncated preset segment not on screen')
  // 真 SGR mode-1003 motion（无按键）：ParamChip 的 onMouseEnter 臂上 600ms dwell，
  // 卡片由 Chat 树尾的单例层画——删掉那一行，这里永远等不到完整名（R1 变红）。
  chat.stdin.write(`\u001b[<35;${cell.col};${cell.row}M`)
  const cardShown = await settled(() => chat.screen().includes(AC4_FULL_PRESET))
  check('R1 真 Chat 树：悬停被截断的 preset 段 → 单例层画出卡片、完整 preset 名上屏（AC-4①，钉 Chat 的 <TooltipLayer />）',
    cutOnScreen && !beforeHover.includes(AC4_FULL_PRESET) && cardShown,
    `cut=${cutOnScreen} beforeHasFull=${beforeHover.includes(AC4_FULL_PRESET)} after=${cardShown} `
      + `cell=${JSON.stringify(cell)} :: ${chat.screen().slice(0, 240)}`)
  // 移开指针（屏角空白）→ 卡片立即撤掉。
  chat.stdin.write('\u001b[<35;1;1M')
  const cardGone = await settled(() => !chat.screen().includes(AC4_FULL_PRESET))
  check('R2 真 Chat 树：指针移开后卡片撤掉（AC-4②：屏上不再有完整名）',
    cardShown && cardGone,
    `wasShown=${cardShown} gone=${cardGone} :: ${chat.screen().slice(0, 240)}`)
  await chat.unmount()
}

{
  // R4 · 复核场景（CodeRabbit 2026-10-05，`Chat.tsx` 落地页分支的 `<TooltipLayer />`）：
  // 悬停被截断的 preset 段把卡片画出来之后，**指针不动**、用键盘把焦点移到权限段并按
  // Enter 打开选择器——落地页仍然挂载（选择器是盖在它之上的浮层），所以"切屏时 ParamChip
  // 卸载"的假设不成立：不给单例层 invalidationKey，旧卡片会继续画在选择器上方。
  // 判据 = 选择器打开后屏上不再有完整 preset 名（卡片被撤）。
  const chat = await mountChat({ launchpadOnBoot: true }, {
    agentPreset: 'standard',
    listPresets: async () => [
      { id: 'standard', name: AC4_FULL_PRESET, isDefault: true },
      { id: 'ptc', name: 'PTC', isDefault: false },
    ],
  } as never)
  const cutOnScreen = await settled(() => {
    const line = viewportLines(chat.term).find(l => l.includes(AC4_CUT_PRESET))
    return line !== undefined && line.includes('…')
  })
  const cell = findParamCell(chat.term, AC4_CUT_PRESET)
  if (cell === null) throw new Error('truncated preset segment not on screen')
  chat.stdin.write(`\u001b[<35;${cell.col};${cell.row}M`)
  const cardShown = await settled(() => chat.screen().includes(AC4_FULL_PRESET))
  // 指针留在原地：Tab 把焦点从被悬停的 preset 段（-4）推到权限段（-5），Enter 开 /permission。
  await chat.send('\t')
  await chat.send('\r')
  const pickerOpen = await settled(() => chat.screen().includes('权限预设'))
  const cardStillThere = chat.screen().includes(AC4_FULL_PRESET)
  check('R4 真 Chat 树：选择器打开时撤掉仍悬停的卡片（落地页分支的 invalidationKey = overlay.kind）',
    cutOnScreen && cardShown && pickerOpen && !cardStillThere,
    `cut=${cutOnScreen} card=${cardShown} picker=${pickerOpen} cardStill=${cardStillThere} `
      + `:: ${chat.screen().slice(0, 260)}`)
  await chat.unmount()
}

if (failures === 0) console.log(`\nverify-launchpad-onboarding-chat: ${checks} checks, all passed`)
else console.error(`\nverify-launchpad-onboarding-chat: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)