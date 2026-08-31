/**
 * ~/.dsh-tui 数据文件权限回归（低危修复）：DATA_DIR 建目录 0700、
 * history.jsonl / mouse-debug.log 落盘 0600。
 *
 * history.jsonl 存用户输入全文（含可能粘贴的密钥/内网路径），mouse-debug.log
 * 记录 UI 事件——多用户主机上按 umask 落成 0644/0775 即同组/其他用户可读。
 * 修复只对新建文件/目录生效（writeFileSync options.mode 仅创建时应用），
 * 不回溯 chmod 旧文件。
 *
 * 隔离手法：临时目录重定向 HOME/USERPROFILE，DATA_DIR 等 paths.ts 的
 * 模块级常量在动态 import 时才解析，因此 env 必须先于 import 设置。
 *
 * 覆盖：
 *   1. appendHistory 触发 DATA_DIR 创建（0700）与 history.jsonl 写入（0600）；
 *   2. logMouseDebug 触发 mouse-debug.log 追加（0600）；
 *   3. 功能未破坏：history 回读得到刚写入的输入。
 *
 * 运行：node --import tsx/esm scripts/verify-data-file-perms.tsx
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 固定 umask：无 mode 参数的默认落盘（0755/0644）不受本机 umask 影响，
// 红态稳定。绿态的 0700/0600 无 group/other 位，任何 umask 都剥不掉。
process.umask(0o022)

const fakeHome = mkdtempSync(join(tmpdir(), 'verify-data-file-perms-'))
process.env.HOME = fakeHome
// os.homedir() 在 win32 上优先 USERPROFILE，一并重定向
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_DEBUG_MOUSE = '1'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

function mode8(path: string): string {
  return (statSync(path).mode & 0o777).toString(8)
}

try {
  // 动态 import：DATA_DIR 常量此刻才以重定向后的 home 解析
  const { appendHistory, loadHistory } = await import('../src/history.js')
  const { logMouseDebug } = await import('../src/utils/debug.js')
  const { writeIndex } = await import('../src/dsh-adapter/sessions/store.js')

  await appendHistory('secret user input / sk-test-123')
  logMouseDebug('mouse arrive', { x: 1 })
  writeIndex(new Map([['s1', {
    derived: {
      revision: 'r1', title: 'secret title', titleSource: 'first-user-input' as never,
      hasPrompt: true, model: undefined, label: undefined,
    },
    branch: 'feature/x',
  }]]))

  const dataDir = join(fakeHome, '.dsh-tui')
  const historyFile = join(dataDir, 'history.jsonl')
  const mouseLog = join(dataDir, 'mouse-debug.log')
  const indexFile = join(dataDir, 'session-index.json')

  check('history.jsonl written', readFileSync(historyFile, 'utf8').includes('secret user input'))
  // 原子替换（复审修复）：写后同目录不得残留 .tmp 中间文件。
  check('atomic history write leaves no .tmp residue',
    !readdirSync(dataDir).some(name => name.endsWith('.tmp')),
    readdirSync(dataDir).join(','))
  check('mouse-debug.log written', readFileSync(mouseLog, 'utf8').includes('mouse arrive'))
  check('history round-trips after perms change', loadHistory().at(0)?.text === 'secret user input / sk-test-123')
  check('session-index.json written', readFileSync(indexFile, 'utf8').includes('secret title'))

  // win32 上 statSync().mode 的 POSIX 位无意义，只验证存在与功能
  if (process.platform !== 'win32') {
    check('DATA_DIR is mode 0700', mode8(dataDir) === '700', `got ${mode8(dataDir)}`)
    check('history.jsonl is mode 0600', mode8(historyFile) === '600', `got ${mode8(historyFile)}`)
    check('mouse-debug.log is mode 0600', mode8(mouseLog) === '600', `got ${mode8(mouseLog)}`)
    check('session-index.json is mode 0600', mode8(indexFile) === '600', `got ${mode8(indexFile)}`)
  }
} finally {
  rmSync(fakeHome, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`verify-data-file-perms: ${failures} 处失败`)
  process.exit(1)
}
console.log('✓ verify-data-file-perms: 目录 0700 / 文件 0600 / 功能回读全部通过')
