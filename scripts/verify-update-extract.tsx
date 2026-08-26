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
 * zip-slip / 符号链接防护（安全审查中危）：解压与替换之间用
 * validateExtractedTree 递归校验提取树——GNU tar 会照常落地指向外部的
 * symlink 成员（实测 link.txt -> /etc/passwd），旧实现 existsSync 后直接
 * copyFileSync 跟随链接读写链接目标；`../` 成员依赖解压器自身拒绝（GNU
 * tar 报错、unzip 剥离前缀），这里断言恶意包解压后树内无逃逸条目。
 *
 * Run: node --import tsx/esm scripts/verify-update-extract.tsx
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

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

// ═══════════════ zip-slip / 符号链接防护 ═══════════════

const validateExtractedTree = (updateModule as Record<string, unknown>).validateExtractedTree as
  | ((extractDir: string) => { ok: boolean; reason?: string })
  | undefined

check('validateExtractedTree 已导出', typeof validateExtractedTree === 'function')

if (typeof validateExtractedTree === 'function') {
  const scratch = mkdtempSync(join(tmpdir(), 'verify-update-extract-'))
  try {
    // 干净树：目录 + 常规文件嵌套 → 放行
    const cleanDir = join(scratch, 'clean')
    mkdirSync(join(cleanDir, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(cleanDir, 'dsh-tui'), 'binary')
    writeFileSync(join(cleanDir, 'sub', 'asset.txt'), 'asset')
    writeFileSync(join(cleanDir, 'sub', 'deep', 'x.bin'), 'x')
    const cleanCheck = validateExtractedTree(cleanDir)
    check('干净提取树放行', cleanCheck.ok, JSON.stringify(cleanCheck))

    // 文件型 symlink 成员（GNU tar 实测照常落地：link.txt -> /etc/passwd）：
    // 必须拒绝，否则替换阶段 copyFileSync 跟随链接读写链接目标。
    const linkDir = join(scratch, 'links')
    mkdirSync(linkDir, { recursive: true })
    writeFileSync(join(linkDir, 'dsh-tui'), 'binary')
    symlinkSync('/etc/passwd', join(linkDir, 'link.txt'))
    const linkCheck = validateExtractedTree(linkDir)
    check('含文件符号链接的提取树被拒绝', !linkCheck.ok, JSON.stringify(linkCheck))

    // 目录型 symlink（嵌套在子目录里、指向外部）同样拒绝。
    const dirLink = join(scratch, 'dirlink')
    mkdirSync(join(dirLink, 'nested'), { recursive: true })
    symlinkSync(scratch, join(dirLink, 'nested', 'escape'))
    const dirLinkCheck = validateExtractedTree(dirLink)
    check('含目录符号链接的提取树被拒绝', !dirLinkCheck.ok, JSON.stringify(dirLinkCheck))

    // 真实恶意 zip：python3 zipfile 允许写入 `../evil.txt` 成员（GNU/Info-ZIP
    // 工具拒绝创建），用更新管线同款 unzip 解压——Info-ZIP 会剥离 ../ 前缀
    // 并以非零码警告。断言 zip-slip 未发生（上级目录无 evil.txt）且树校验
    // 与解压结果一致。
    const evilZipDir = join(scratch, 'evil-zip')
    const extractOut = join(evilZipDir, 'extracted')
    mkdirSync(extractOut, { recursive: true })
    const evilZip = join(evilZipDir, 'evil.zip')
    execFileSync('python3', [
      '-c',
      'import zipfile,sys;'
      + 'z=zipfile.ZipFile(sys.argv[1],"w");'
      + 'z.writestr("../evil.txt","evil");'
      + 'z.writestr("dsh-tui","binary");'
      + 'z.close()',
      evilZip,
    ])
    let unzipExit = 0
    try {
      execFileSync('unzip', ['-o', evilZip, '-d', extractOut], { stdio: 'ignore' })
    } catch {
      unzipExit = 1
    }
    const evilCheck = validateExtractedTree(extractOut)
    check(
      '恶意 zip（../evil.txt 成员）经管线解压后提取树安全（无逃逸/链接条目，或解压失败被拒）',
      evilCheck.ok || (!evilCheck.ok && unzipExit !== 0),
      `unzipExit=${unzipExit} check=${JSON.stringify(evilCheck)}`,
    )
    check(
      '恶意 zip 的 ../evil.txt 未落在提取目录之外（zip-slip 未发生）',
      !existsQuiet(join(evilZipDir, 'evil.txt')) && !existsQuiet(join(scratch, 'evil.txt')),
    )

    // 真实恶意 tar.gz：python3 tarfile 写入指向 /etc/passwd 的 symlink 成员，
    // 用更新管线同款 `tar -xzf` 解压——GNU tar 照常落地链接（实测），树校验
    // 必须在替换前拦下。
    const evilTarDir = join(scratch, 'evil-tar')
    const tarOut = join(evilTarDir, 'extracted')
    mkdirSync(tarOut, { recursive: true })
    const evilTar = join(evilTarDir, 'evil.tar.gz')
    execFileSync('python3', [
      '-c',
      'import tarfile,io,sys;'
      + 't=tarfile.open(sys.argv[1],"w:gz");'
      + 'data=b"binary";'
      + 'ti=tarfile.TarInfo("dsh-tui");ti.size=len(data);t.addfile(ti,io.BytesIO(data));'
      + 'lk=tarfile.TarInfo("link.txt");lk.type=tarfile.SYMTYPE;lk.linkname="/etc/passwd";t.addfile(lk);'
      + 't.close()',
      evilTar,
    ])
    execFileSync('tar', ['-xzf', evilTar, '-C', tarOut], { stdio: 'ignore' })
    check(
      'symlink 成员确实被 GNU tar 落地（fixture 有效性）',
      existsQuiet(join(tarOut, 'link.txt')),
    )
    const tarCheck = validateExtractedTree(tarOut)
    check('含 symlink 成员的 tar.gz 解压树被检测函数拒绝', !tarCheck.ok, JSON.stringify(tarCheck))
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function existsQuiet(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

if (failures > 0) {
  console.error(`\nverify-update-extract: ${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nverify-update-extract: 全部断言通过')
