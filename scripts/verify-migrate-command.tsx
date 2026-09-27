/**
 * `/migrate` 交互回归（挂真实 Chat，fake channel + fake stdout/stdin）：
 *   1. **fresh 会话直接入口**：mount 后第一次就输入 `/migrate claude-code`
 *      必须打开确认层——旧实现从 picker 的行缓存里查 agent，缓存为空时
 *      一律报「未知迁移源」，正是 docs/migrate.md 承诺的那个入口；
 *   2. 未知源仍然报未知（不能因为修 1 而放行任意字符串）；
 *   3. `/migrate --dry-run` 明说要源，不再报「未知迁移源 --dry-run」；
 *   4. `/migrate a b` 报 usage，不静默只跑第一个（与 CLI 退出码 2 同语义）；
 *   5. 重开裸 `/migrate` 清空上一轮的勾选（Esc 退出后不得残留 [x]）。
 * 运行：node --import tsx/esm scripts/verify-migrate-command.tsx
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
// adapter 走 os.homedir()（Windows 读 USERPROFILE）：两个都指到空夹具目录，
// 扫描既不碰真实数据，也保证各源计数为 0、启动提示检测无信号。
const fixtureHome = mkdtempSync(join(tmpdir(), 'verify-migrate-command-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome

const [{ PassThrough, Writable }, React, { render }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
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

const plainText = (frames: readonly string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ESC = '\u001b'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${extra ? `  (${extra})` : ''}`)
  }
}

/** Fake channel in smoke.tsx's shape: Chat reads a wide surface, so the stub
 *  carries the fields it renders plus the calls these assertions observe. */
function makeChannel() {
  return {
    version: 0,
    whaleIdle: false,
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
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
    commandList: LOCAL_COMMANDS,
    commandCompletions: () => [],
    notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submitCalls: [] as string[],
    notifyCalls: [] as string[],
    localRows: [] as string[][],
    submit(text: string) { this.submitCalls.push(text) },
    steer() {},
    cancel() {},
    clear() {},
    notify(text: string) { this.notifyCalls.push(text) },
    pushLocal(_command: string, lines: readonly string[]) { this.localRows.push([...lines]) },
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  }
}

type FakeChannel = ReturnType<typeof makeChannel>

/** One mounted Chat, torn down by the caller. `run` types a line and settles. */
async function mountChat(): Promise<{
  channel: FakeChannel
  stdout: FakeStdout
  stdin: FakeStdin
  run: (line: string) => Promise<string>
  keys: (sequence: readonly string[]) => Promise<void>
  mark: () => number
  since: (mark: number) => string
  unmount: () => Promise<void>
}> {
  const channel = makeChannel()
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} />,
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await delay(400)
  return {
    channel,
    stdout,
    stdin,
    mark: () => stdout.frames.length,
    since: m => plainText(stdout.frames.slice(m)),
    run: async (line: string) => {
      const from = stdout.frames.length
      stdin.write(line)
      await delay(120)
      stdin.write('\r')
      await delay(700)
      return plainText(stdout.frames.slice(from))
    },
    keys: async (sequence: readonly string[]) => {
      for (const key of sequence) {
        stdin.write(key)
        await delay(220)
      }
    },
    unmount: async () => { await instance.unmount() },
  }
}

const CONFIRM_TITLE = '确认导入'
const PICKER_TITLE = '迁移哪个代理的对话？'
const UNKNOWN = '未知迁移源'

// ── 1. fresh 会话的 /migrate <agent>（本回归的存在理由）──────────────────
{
  const chat = await mountChat()
  const after = await chat.run('/migrate claude-code')
  const unknown = chat.channel.notifyCalls.filter(text => text.includes(UNKNOWN))
  check('1a. fresh mount 直接 /migrate claude-code 不报未知源', unknown.length === 0, unknown.join(' | '))
  check('1b. 打开二次确认层', after.includes(CONFIRM_TITLE))
  check('1c. 不误开选择器', !after.includes(PICKER_TITLE))
  await chat.unmount()
}

// ── 2. 未知源仍然被拒 ──────────────────────────────────────────────────
{
  const chat = await mountChat()
  const after = await chat.run('/migrate not-an-agent')
  check('2a. 未知源报未知迁移源', chat.channel.notifyCalls.some(text => text.includes(UNKNOWN)))
  check('2b. 不打开确认层', !after.includes(CONFIRM_TITLE))
  await chat.unmount()
}

// ── 3. --dry-run 的语义 ────────────────────────────────────────────────
{
  const chat = await mountChat()
  const after = await chat.run('/migrate --dry-run')
  check('3a. 裸 --dry-run 提示要指明源（不再报“未知迁移源 --dry-run”）',
    chat.channel.notifyCalls.some(text => text.includes('指明要预览的源'))
    && !chat.channel.notifyCalls.some(text => text.includes(UNKNOWN)),
    chat.channel.notifyCalls.join(' | '))
  check('3b. 不打开确认层', !after.includes(CONFIRM_TITLE))
  await chat.unmount()
}

// ── 4. 多参数（与 CLI 的 usage 退出码 2 同语义）────────────────────────
{
  const chat = await mountChat()
  const after = await chat.run('/migrate claude-code codex')
  check('4a. 两个源报 usage',
    chat.channel.notifyCalls.some(text => text.includes('一次只能迁移一个源')),
    chat.channel.notifyCalls.join(' | '))
  check('4b. 不打开确认层', !after.includes(CONFIRM_TITLE))
  await chat.unmount()
}

// ── 5. 重开 picker 清空上一轮勾选 ──────────────────────────────────────
{
  const chat = await mountChat()
  await chat.run('/migrate')
  await chat.keys([' ', ESC])
  const mark = chat.mark()
  await chat.run('/migrate')
  const reopened = chat.since(mark)
  check('5a. 重开渲染出源行（行缓存不是空态）', reopened.includes('Claude Code'))
  check('5b. 重开 picker 不残留上一轮勾选', !reopened.includes('[x]'), reopened.replace(/\s+/gu, ' ').slice(0, 120))
  await chat.unmount()
}

rmSync(fixtureHome, { recursive: true, force: true })
if (failures > 0) {
  console.error(`/migrate 交互回归 FAILED（${failures} 项）`)
  process.exitCode = 1
} else {
  console.log('/migrate 交互回归 passed')
}
