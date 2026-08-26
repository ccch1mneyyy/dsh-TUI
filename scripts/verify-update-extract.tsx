/**
 * 便携包更新解压链安全回归（src/update.ts）。
 *
 * Windows 解压的 PowerShell 单引号注入（安全审查中危）：
 * 下载/解压路径派生自 DSH_TUI_STANDALONE_CACHE 等环境变量，旧实现把
 * 路径直接拼进 `Expand-Archive -Path '...' -DestinationPath '...'` 的
 * PowerShell 单引号字符串——路径里一个 `'` 就能闭合字面量注入任意命令
 * （`;Calc.exe;'+'` 类 payload）。断言：
 *  - escapePsSingleQuoted：`'` → `''`（src/utils/clipboard.ts 同款约定）；
 *  - windowsExtractPlan(tar 可用)：走 tar.exe 数组参数（无 shell、无拼接，
 *    路径原样传递），绝不生成 PowerShell 命令；
 *  - windowsExtractPlan(tar 不可用回退)：Expand-Archive 命令里每个路径
 *    字面量自洽闭合（单引号总数为偶），`;` / 反引号 / `$` 全部落在引号内
 *    （字面量化，无逃逸）。
 *
 * Run: node --import tsx/esm scripts/verify-update-extract.tsx
 */

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

const updateModule = await import('../src/update.js')
const escapePsSingleQuoted = (updateModule as Record<string, unknown>).escapePsSingleQuoted as
  | ((value: string) => string)
  | undefined
const windowsExtractPlan = (updateModule as Record<string, unknown>).windowsExtractPlan as
  | ((downloadPath: string, extractDir: string, tarAvailable: boolean) =>
      { tool: 'tar'; args: string[] } | { tool: 'powershell'; args: string[] })
  | undefined

// ═══════════════ PowerShell 单引号注入 ═══════════════

check('escapePsSingleQuoted 已导出', typeof escapePsSingleQuoted === 'function')
check('windowsExtractPlan 已导出', typeof windowsExtractPlan === 'function')

if (typeof escapePsSingleQuoted === 'function') {
  check(
    "escapePsSingleQuoted 把 ' 双写为 ''",
    escapePsSingleQuoted("it's a'path") === "it''s a''path",
    escapePsSingleQuoted("it's a'path"),
  )
  check(
    'escapePsSingleQuoted 无引号路径原样返回',
    escapePsSingleQuoted('C:\\cache\\dsh-tui') === 'C:\\cache\\dsh-tui',
  )
}

// 恶意路径：单引号闭合 + 分号 + 反引号 + $() 子表达式——旧拼接实现下
// 这串足以逃逸字面量执行任意 PowerShell。
const evilDownload = "C:\\Users'a';Calc.exe;Remove-Item -Recurse 'C:\\`;$(Start-Process calc)"
const evilExtract = "D:\\tmp'x';Whoami`n$(ipconfig)\\extracted"

if (typeof windowsExtractPlan === 'function') {
  // (a) tar 路径：数组参数、无 PowerShell
  const tarPlan = windowsExtractPlan(evilDownload, evilExtract, true)
  check(
    'tar 可用时计划走 tar.exe（不经 PowerShell）',
    tarPlan.tool === 'tar',
    JSON.stringify(tarPlan),
  )
  check(
    'tar 计划是数组参数且路径原样传递（无 shell 拼接）',
    Array.isArray(tarPlan.args) && tarPlan.args.length === 4
      && tarPlan.args[0] === '-xf' && tarPlan.args[1] === evilDownload
      && tarPlan.args[2] === '-C' && tarPlan.args[3] === evilExtract,
    JSON.stringify(tarPlan.args),
  )

  // (b) 回退路径：转义后无逃逸
  const psPlan = windowsExtractPlan(evilDownload, evilExtract, false)
  check(
    'tar 不可用时回退 PowerShell Expand-Archive',
    psPlan.tool === 'powershell'
      && psPlan.args[0] === '-NoProfile' && psPlan.args[1] === '-Command'
      && psPlan.args[2].includes('Expand-Archive'),
    JSON.stringify(psPlan),
  )
  if (psPlan.tool === 'powershell') {
    const command = psPlan.args[2]
    const quoteCount = (command.match(/'/g) ?? []).length
    check('回退命令单引号总数为偶数（每个字面量自洽闭合）', quoteCount % 2 === 0, `count=${quoteCount}`)

    // 单引号状态机：引号外的字符集合里不得出现 ; ` $ —— 出现即说明
    // payload 逃逸出了字面量，回到可执行命令文本。
    let inQuote = false
    const outside: string[] = []
    for (const ch of command) {
      if (ch === "'") inQuote = !inQuote
      else if (!inQuote) outside.push(ch)
    }
    check(
      '回退命令引号外无 ; / 反引号 / $（payload 全部字面量化）',
      !outside.includes(';') && !outside.includes('`') && !outside.includes('$'),
      `outside=${JSON.stringify(outside.join(''))}`,
    )
    // 逃逸还原：把 '' 折叠回 ' 后必须能取回原始恶意路径（证明注入字符
    // 只是被转义，而不是被剥离或漏拼）。
    const folded = command.replace(/''/g, "'")
    check(
      '回退命令转义还原后包含完整原始路径',
      folded.includes(evilDownload) && folded.includes(evilExtract),
    )
  }
}

if (failures > 0) {
  console.error(`\nverify-update-extract: ${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nverify-update-extract: 全部断言通过')
