/**
 * 外部编辑器回归（issue #123）：Ctrl+X 的 $VISUAL/$EDITOR 解析与临时文件
 * 往返。覆盖：
 *
 * - splitEditorCommand：空白拆分 + 单双引号（`code --wait`、带空格路径）
 * - resolveEditorCommand：VISUAL 优先于 EDITOR、空白值跳过、POSIX 回退
 *   vi、Windows 无编辑器 → undefined
 * - resolveWindowsShim：PATH/PATHEXT 解析（code → code.cmd 走 cmd.exe，
 *   code.exe 直接 spawn），显式扩展名原样通过
 * - editInExternalEditor 端到端（node 假编辑器进程）：
 *   追加写入 → edited；未改动 → unchanged；非零退出（:cq）→ unchanged；
 *   编辑器不存在 → failed；尾部换行边界（草稿自带 \n 的无操作保存不得
 *   误判 edited；编辑器补的终止换行不得算内容）；临时目录不可写
 *   （TMPDIR 指向不存在路径）→ failed 而非未处理拒绝
 *
 * CI 无 TTY：instances.get 拿不到 Ink 实例，util 跳过 alt-screen 移交直接
 * inherit stdio，编辑器往返路径照常受测。EDITOR 串里的 node/helper 路径
 * 一律加双引号——Windows 默认 Node 安装路径含空格，拆分时不能断。
 *
 * Run with plain node against the compiled lib: `node scripts/verify-external-editor.mjs`
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  editInExternalEditor,
  resolveEditorCommand,
  resolveWindowsShim,
  splitEditorCommand,
} from '../lib/types/utils/externalEditor.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── splitEditorCommand ────────────────────────────────────────────────
check('split: 空白拆分带参数', eq(splitEditorCommand('code --wait'), ['code', '--wait']))
check('split: 双引号包住带空格路径', eq(splitEditorCommand('"/opt/my editor/nvim" -f'), ['/opt/my editor/nvim', '-f']))
check('split: 单引号参数', eq(splitEditorCommand("nano '--restricted'"), ['nano', '--restricted']))
check('split: 空串 → 空数组', eq(splitEditorCommand('   '), []))

// ── resolveEditorCommand ─────────────────────────────────────────────
check('resolve: VISUAL 优先', eq(resolveEditorCommand({ VISUAL: 'vim', EDITOR: 'nano' }), ['vim']))
check('resolve: VISUAL 空白跳过用 EDITOR', eq(resolveEditorCommand({ VISUAL: '  ', EDITOR: 'nano' }), ['nano']))
check('resolve: 带参数整串解析', eq(resolveEditorCommand({ EDITOR: 'code --wait' }), ['code', '--wait']))
check('resolve: Windows 无编辑器 → undefined', resolveEditorCommand({}, 'win32') === undefined)
if (process.platform !== 'win32') {
  check('resolve: POSIX 兜底 vi', eq(resolveEditorCommand({}), ['vi']))
}

// ── resolveWindowsShim（PATH 里有 code.cmd / code.exe 的模拟目录）─────
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-editor-'))
const shimDir = join(scratch, 'shim-bin')
mkdirSync(shimDir)
writeFileSync(join(shimDir, 'code.cmd'), '@echo off\r\n')
writeFileSync(join(shimDir, 'gvim.exe'), 'MZ')
const shimEnv = { PATH: shimDir, PATHEXT: '.EXE;.CMD' }
{
  const cmd = resolveWindowsShim('code', shimEnv)
  check('shim: code → code.cmd 走 cmd.exe', cmd.viaCmd && /code\.cmd$/i.test(cmd.command), JSON.stringify(cmd))
}
{
  const exe = resolveWindowsShim('gvim', shimEnv)
  check('shim: gvim → gvim.exe 直接 spawn', !exe.viaCmd && /gvim\.exe$/i.test(exe.command), JSON.stringify(exe))
}
{
  const explicit = resolveWindowsShim('nvim.cmd', shimEnv)
  check('shim: 显式 .cmd 扩展名原样通过', explicit.viaCmd && explicit.command === 'nvim.cmd')
}
{
  const missing = resolveWindowsShim('not-on-path', shimEnv)
  check('shim: 解析不到回退裸命令', !missing.viaCmd && missing.command === 'not-on-path')
}

// ── editInExternalEditor 端到端（假编辑器）─────────────────────────────
// 假编辑器：node 跑一段脚本文件，按 mode 对目标文件追加/不动/补终止换行/
// 非零退出。用文件而非 -e 内联脚本，避免引号嵌套干扰 splitEditorCommand。
const helper = join(scratch, 'fake-editor.cjs')
writeFileSync(helper, `
const fs = require('node:fs')
const [mode, file] = process.argv.slice(2)
if (mode === 'append') fs.appendFileSync(file, '\\nedited\\n')
if (mode === 'replace') fs.writeFileSync(file, 'replaced content\\n')
if (mode === 'ensure-newline') {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.endsWith('\\n')) fs.appendFileSync(file, '\\n')
}
if (mode === 'fail') process.exit(3)
`)

const savedEnv = {
  VISUAL: process.env.VISUAL,
  EDITOR: process.env.EDITOR,
  TMPDIR: process.env.TMPDIR,
}
function useEditor(spec) {
  delete process.env.VISUAL
  process.env.EDITOR = spec
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// 路径一律加引号：含空格的安装路径（Windows 默认 Node 目录）不得被拆断。
const base = `"${process.execPath}" "${helper}"`

useEditor(`${base} append`)
const appended = await editInExternalEditor('hello')
check(
  '往返: 追加写入 → edited，编辑器补的终止换行剥离',
  appended.kind === 'edited' && appended.text === 'hello\nedited',
  JSON.stringify(appended),
)

useEditor(`${base} replace`)
const replaced = await editInExternalEditor('')
check(
  '往返: 空草稿被整体替换 → edited',
  replaced.kind === 'edited' && replaced.text === 'replaced content',
  JSON.stringify(replaced),
)

useEditor(`${base} noop`)
const untouched = await editInExternalEditor('keep me')
check('往返: 未改动 → unchanged', untouched.kind === 'unchanged', JSON.stringify(untouched))

useEditor(`${base} noop`)
const trailingKept = await editInExternalEditor('keep\n')
check(
  '往返: 草稿自带尾部换行 + 无操作保存 → unchanged（不得误判 edited 丢换行）',
  trailingKept.kind === 'unchanged',
  JSON.stringify(trailingKept),
)

useEditor(`${base} ensure-newline`)
const ensuredNewline = await editInExternalEditor('hello')
check(
  '往返: 编辑器仅补终止换行 → unchanged（不算编辑）',
  ensuredNewline.kind === 'unchanged',
  JSON.stringify(ensuredNewline),
)

useEditor(`${base} append`)
const multilineTail = await editInExternalEditor('tail\n\n')
check(
  '往返: 草稿自带尾部空行（Shift+Enter）在编辑后保留',
  multilineTail.kind === 'edited' && multilineTail.text.startsWith('tail\n\n'),
  JSON.stringify(multilineTail),
)

useEditor(`${base} fail`)
const aborted = await editInExternalEditor('keep me')
check('往返: 非零退出（:cq）→ unchanged 保留原稿', aborted.kind === 'unchanged', JSON.stringify(aborted))

useEditor('/nonexistent-editor-dsh-tui-xyz')
const broken = await editInExternalEditor('draft')
check(
  '往返: 编辑器不存在 → failed 并报出命令名',
  broken.kind === 'failed' && broken.message.includes('nonexistent-editor-dsh-tui-xyz'),
  JSON.stringify(broken),
)

if (process.platform !== 'win32') {
  // 审阅复现用例：EDITOR=/bin/rm 删掉草稿文件并成功退出，readFile 的
  // ENOENT 曾以未处理拒绝终结进程；现在必须映射为 unchanged。
  useEditor('/bin/rm')
  const removed = await editInExternalEditor('draft')
  check(
    '往返: EDITOR=/bin/rm（文件被删）→ unchanged 不抛出',
    removed.kind === 'unchanged',
    JSON.stringify(removed),
  )

  // mkdtemp 失败必须映射为 failed 结果而不是未处理拒绝（审阅 P1：
  // 曾以 EDITOR=/bin/rm 复现未捕获的 ENOENT 终结进程）。
  process.env.TMPDIR = '/nonexistent-tmpdir-dsh-tui-xyz'
  useEditor(`${base} noop`)
  const fsFailed = await editInExternalEditor('draft')
  check(
    '往返: 临时目录不可写 → failed（不抛出、不杀进程）',
    fsFailed.kind === 'failed' && fsFailed.message.includes('nonexistent-tmpdir'),
    JSON.stringify(fsFailed),
  )
  process.env.TMPDIR = savedEnv.TMPDIR ?? tmpdir()
  if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR
}

restoreEnv()
rmSync(scratch, { recursive: true, force: true })

console.log(failed === 0 ? 'OK' : `FAILED: ${failed} check(s)`)
process.exit(failed === 0 ? 0 : 1)
