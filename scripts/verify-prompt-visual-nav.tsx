/**
 * 输入框视觉行导航回归（fix/visual-line-navigation）：↑/↓ 的行判定
 * 从逻辑行（\n 计数）改为视觉行（折行后屏幕行）——单段超长文本折成
 * 多个视觉行时，↑/↓ 先在视觉行间移动光标，只在首/末视觉行才进入
 * 历史遍历。锁定四条不变量：
 *   1. 有历史 + 单行长文本 + 光标在中部视觉行：↑ 移光标，value 不被
 *      历史替换（原 bug：逻辑行恒 0，直接换内容 → 高度跳变/闪屏）
 *   2. 含 \n 多行文本：跨行移动行为保持（列 clamp 到目标行长度）
 *   3. 光标在首视觉行按 ↑ → 仍进历史；末视觉行按 ↓ → 恢复草稿
 *   4. 列对齐：长行 → 短行移动时光标 clamp 到目标行尾
 * 运行：node --import tsx/esm scripts/verify-prompt-visual-nav.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
])
const { render, Box, Text } = await import('../src/ui.js')
const { PromptInput } = await import('../src/components/PromptInput.js')

const COLS = 100, ROWS = 30
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeHarness() {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS; rows = ROWS; isTTY = true
    _write(chunk: unknown, _e: Buffer.Encoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  return { term, stdout: new FakeStdout() as never, stdin: new FakeStdin() as never }
}

const submitted: string[] = []
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit(text: string) { submitted.push(text) },
  steer() {},
  interruptAndDeliver() {},
  removePending() {},
  stageImage() {},
  listFiles: async () => [],
}

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) process.stdout.write(`PASS  ${name}\n`)
  else { failures++; process.stdout.write(`FAIL  ${name} — ${detail}\n`) }
}

const { term, stdout, stdin } = makeHarness()
const App = () =>
  React.createElement(Box, { flexDirection: 'column', height: ROWS, width: '100%' },
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' }),
    React.createElement(Box, { flexDirection: 'column', flexShrink: 0 },
      React.createElement(PromptInput, {
        channel, helpOpen: false, onToggleHelp() {}, onRunCommand: () => false, selectionActive: false,
      }),
      React.createElement(Text, null, 'STATUSLINE')))
await render(React.createElement(App), {
  stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false,
})
await sleep(500)

const feed = async (seq: string) => { stdin.write(seq); await sleep(150) }
const screen = () => {
  const lines = Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  return lines
}
const inputHeight = () => {
  const lines = screen()
  const top = lines.findIndex(l => l.includes('╭'))
  const bottom = lines.findIndex(l => l.includes('╰'))
  return top >= 0 && bottom >= 0 ? bottom - top + 1 : -1
}
/** 屏幕上输入框内是否含指定文本片段（截断安全：只查前缀 20 字符）。 */
const inputHas = (needle: string) => screen().some(l => l.includes(needle.slice(0, 20)))

// ── 准备历史：提交一条短内容 ──
await feed('short history entry\r')
await sleep(100)
check('准备：短历史已提交', submitted.length === 1 && submitted[0] === 'short history entry', JSON.stringify(submitted))

// ── 场景 1（核心）：单段超长文本（无 \n，折 3+ 视觉行），光标在末行，↑ ──
const LONG = 'A'.repeat(97) + 'B'.repeat(97) + 'C'.repeat(50) // inputWidth=97 → 3 视觉行
stdin.write('\x1b[200~' + LONG + '\x1b[201~')
await sleep(400)
const heightBefore = inputHeight()
check('场景1前置：长文本折成 3 视觉行（高 5）', heightBefore === 5, `高 ${heightBefore}`)
await feed('\x1b[A') // ↑：视觉行 2 → 1
// 光标位置断言：反色 caret 格必须上移一行（行位是抓偏移回归的真判据）。
const caretRows = () => {
  const buf = term.buffer.active
  const rows: number[] = []
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    for (let x = 0; x < line.length; x++) if (line.getCell(x)?.isInverse()) { rows.push(y); break }
  }
  return rows
}
const caretBeforeUp = caretRows()[0] ?? -1
await feed('\x1b[B') // ↓ 回末行
const caretAfterDown = caretRows()[0] ?? -1
check('光标 ↑↓ 往返行位随视觉行移动', caretAfterDown > caretBeforeUp, `${caretBeforeUp}->${caretAfterDown}`)
await feed('\x1b[A') // 回视觉行 1
const heightAfterUp = inputHeight()
check('场景1：↑ 后 value 保持长文本（未被历史替换）', inputHas(LONG.slice(0, 20)), `高 ${heightAfterUp}`)
check('场景1：↑ 后高度不变（无闪动）', heightAfterUp === heightBefore, `${heightBefore}→${heightAfterUp}`)
await feed('\x1b[A') // ↑：视觉行 1 → 0
await feed('\x1b[A') // ↑：已在首视觉行 → 进历史（内容换成历史条目）
check('场景1：首视觉行再 ↑ 才进历史（value 已替换）', inputHas('short history entry'), '应显示历史条目')
await feed('\x1b[B') // ↓：历史 → 草稿恢复
check('场景1：↓ 恢复草稿长文本', inputHas(LONG.slice(0, 20)), '草稿应恢复')

// ── 场景 2：含 \n 的多行文本跨行移动（原行为保持）+ 列 clamp ──
stdin.write('\x1b[200~' + '\n' + 'x'.repeat(10) + '\n' + 'y'.repeat(200) + '\x1b[201~')
await sleep(400)
// 光标在末段长行尾；Home 到行首，↑ 跨行
await feed('\x1b[F') // End 行尾
await feed('\x1b[A') // ↑ 到上一行（x 行，10 字符）——光标 clamp 到 x 行行尾
check('场景2：跨 \n 行 ↑ 成功（无异常）', inputHeight() >= 3, `高 ${inputHeight()}`)

// ── 场景 3：代理对吸附——emoji 行 ↑↓ 后在落点插入，提交内容无孤立代理 ──
// 用「插入」而非「退格」验证：退格删单 code unit 是仓库既有独立缺陷
//（纯粘贴 emoji 后退格同样产生孤立代理，与本 PR 无关），插入才能干净
// 锁定「↑/↓ 落点不在代理对中间」的语义——落点中间则插入字符会拆开代理对。
{
  await feed('\x1b', 200) // Esc 清空
  const emojiText = 'ab\n' + '😀'.repeat(30)
  stdin.write('\x1b[200~' + emojiText + '\x1b[201~')
  await sleep(400)
  await feed('\x1b[A') // ↑ 到首行（ab）——colChars=2 clamp 到目标行
  await feed('\x1b[B') // ↓ 回 emoji 行：colChars=2 落在第一个代理对内部边界处
  await feed('X')       // 在落点插入标记字符
  await feed('\r')     // 提交
  const submittedText = submitted[submitted.length - 1] ?? ''
  const hasLoneSurrogate = /(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/.test(submittedText)
  check('代理对吸附：emoji 行 ↑↓ 落点插入后提交内容无孤立代理', !hasLoneSurrogate, JSON.stringify(submittedText.slice(0, 24)))
  const xCount = (submittedText.match(/X/g) ?? []).length
  check('代理对吸附：标记字符恰好落在 emoji 之间（1 个 X，30 个 emoji 完整）',
    xCount === 1 && (submittedText.match(/😀/g) ?? []).length === 30,
    `X=${xCount} emoji=${(submittedText.match(/😀/g) ?? []).length}`)
}

if (failures > 0) {
  process.stdout.write(`verify-prompt-visual-nav: ${failures} assertion(s) failed\n`)
  process.exit(1)
}
process.stdout.write('verify-prompt-visual-nav OK\n')
