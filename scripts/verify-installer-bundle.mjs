#!/usr/bin/env node
/**
 * verify-installer-bundle.mjs — 一键安装整合包文本产物的行尾/编码契约回归（#1068）。
 *
 * 生成器用同一条 LF/无 BOM 路径写出全部 5 个文本产物，但宿主契约各不相同：
 * cmd.exe 需要 .bat 为 CRLF（LF-only 会被逐行误切），Windows PowerShell 5.1
 * 需要 .ps1 带 UTF-8 BOM 才能正确解码中文，POSIX 要求 .sh 保持 LF。产物是
 * 发布资产的一部分，契约必须由回归锚定，否则缺陷会随每个 Release 稳定复发。
 *
 * 平台：全平台可跑。Windows 专属组（PS 5.1 默认解码 / cmd 冒烟）在非 Windows
 * 上打显式 SKIP 并计入 SKIPPED；本入口只留 SKIP 占位（T02 填实），不冒充 PASS。
 *
 * 运行：node scripts/verify-installer-bundle.mjs（有 FAIL 即以非 0 退出）
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

let passed = 0
let failed = 0
let skipped = 0

// 断言出口只有这一个：失败必须含 文件 + 首个违规字节偏移（D6）——行尾/BOM 问题
// 肉眼不可见，偏移量是唯一能快速定位的线索；文件读不到要变成 FAIL 而不是栈中途
// 中止（否则后面的断言根本不跑）。
const pass = label => {
  passed++
  console.log(`PASS: ${label}`)
}
const fail = (file, reason, offset) => {
  failed++
  console.log(`FAIL: ${file}: ${reason}（首个违规字节偏移 ${offset}）`)
}
const skip = (group, reason) => {
  skipped++
  console.log(`SKIP: ${group}  (${reason})`)
}

// 首个裸 LF：0x0A 的前一字节必须是 0x0D；-1 = 无违规。
const bareLfAt = bytes => {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0A && bytes[i - 1] !== 0x0D) return i
  return -1
}
// 首个 BOM 字节不符位置：-1 = 前 3 字节恰为 EF BB BF。
const bomMismatchAt = bytes => {
  const bom = [0xEF, 0xBB, 0xBF]
  for (let i = 0; i < 3; i++) if (bytes[i] !== bom[i]) return i
  return -1
}
const hex = bytes => [...bytes.subarray(0, 3)].map(b => b.toString(16).padStart(2, '0')).join(' ')

// 生成器产出到 mkdtemp 隔离目录，只断言 staging 文本；zip 打包（既有行为）与断言
// 无关，但随生成器一起真实执行。结束时无论晴雨都清掉临时目录（AC-6 零副作用）。
const tmp = mkdtempSync(join(tmpdir(), 'dsh-installer-'))
const stage = file => join(tmp, 'dsh-tui-setup', file)
let exitCode = 1
try {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'make-installer-bundle.mjs'), '--out', tmp], { stdio: 'inherit' })
  } catch (err) {
    fail('scripts/make-installer-bundle.mjs', `生成器退出非 0（status=${err.status ?? 'signal'}）`, 'N/A')
  }

  const read = file => {
    try {
      return readFileSync(stage(file))
    } catch {
      fail(file, '文件缺失或不可读', 'N/A')
      return null
    }
  }

  // .bat × 2：cmd.exe 的 CRLF 解析契约。
  for (const file of ['install.bat', '启动 dsh-tui.bat']) {
    const bytes = read(file)
    if (!bytes) continue
    const offset = bareLfAt(bytes)
    if (offset === -1) pass(`${file}: CRLF（0x0A 前一字节均为 0x0D）`)
    else fail(file, '裸 LF（0x0A 前一字节不是 0x0D）', offset)
  }

  // install.ps1：Windows PowerShell 5.1 默认按 ANSI 解码，没有 BOM 中文必乱码。
  {
    const bytes = read('install.ps1')
    if (bytes) {
      const offset = bomMismatchAt(bytes)
      if (offset === -1) pass('install.ps1: UTF-8 BOM（EF BB BF）')
      else fail('install.ps1', `缺 UTF-8 BOM（实际前 3 字节 ${hex(bytes)}，期望 EF BB BF）`, offset)
    }
  }

  // install.sh：POSIX 契约，任何 0x0D 都会污染 shebang / 参数。
  {
    const bytes = read('install.sh')
    if (bytes) {
      const offset = bytes.indexOf(0x0D)
      if (offset === -1) pass('install.sh: LF（不含 0x0D）')
      else fail('install.sh', '含 0x0D（应为 LF）', offset)
    }
  }

  // 使用说明.txt：读者是编辑器而非解释器 → LF 且无 BOM；两条契约分别断言，
  // 失败时各自给偏移。
  {
    const bytes = read('使用说明.txt')
    if (bytes) {
      if (bomMismatchAt(bytes) !== -1) pass('使用说明.txt: 无 BOM')
      else fail('使用说明.txt', '不应带 UTF-8 BOM', 0)
      const offset = bytes.indexOf(0x0D)
      if (offset === -1) pass('使用说明.txt: LF（不含 0x0D）')
      else fail('使用说明.txt', '含 0x0D（应为 LF）', offset)
    }
  }

  // Windows 专属组：T01 只占位（T02 填实）；非 Windows 本就不适用。两组都计入
  // SKIPPED，不得计入 PASS。
  skip('PS 5.1 默认解码回读 install.ps1', isWin ? 'T01 占位（T02 填实）' : '需要 Windows PowerShell 5.1')
  skip('cmd 冒烟 install.bat（stub 隔离）', isWin ? 'T01 占位（T02 填实）' : '需要 cmd.exe')

  console.log(`\nPASS: ${passed} / FAIL: ${failed} / SKIPPED: ${skipped}`)
  exitCode = failed === 0 ? 0 : 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(exitCode)
