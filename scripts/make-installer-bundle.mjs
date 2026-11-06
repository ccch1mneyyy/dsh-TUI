#!/usr/bin/env node
/**
 * 生成 dsh-TUI 一键安装整合包（zip）。
 *
 * 用法：
 *   node scripts/make-installer-bundle.mjs [--out <dir>]
 *
 * 产物：<out>/dsh-tui-setup.zip，内含：
 *   dsh-tui-setup/
 *     install.bat         Windows 双击即装（ASCII 壳，调 install.ps1）
 *     install.ps1         Windows 安装主体（UTF-8 中文提示）
 *     install.sh          macOS / Linux 一键安装
 *     启动 dsh-tui.bat    Windows 双击启动
 *     使用说明.txt         使用说明（中英）
 *
 * CI（release 事件）与本地均可用；Windows 用 PowerShell Compress-Archive，
 * 其他平台用系统 zip。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pnpmVersion = pkg.packageManager.match(/^pnpm@([\d.]+)(?:\+|$)/)?.[1]
if (!pnpmVersion) throw new Error('packageManager must pin a pnpm version')
const argOut = process.argv.indexOf('--out')
const outDir = resolve(argOut >= 0 ? process.argv[argOut + 1] : join(root, 'dist-bundle'))
const pkgDirName = 'dsh-tui-setup'
const zipName = 'dsh-tui-setup.zip'

// ─── 模板 ───────────────────────────────────────────────────────────────────

const INSTALL_BAT = `@echo off
rem dsh-TUI one-click installer launcher (Windows)
rem The real installer is install.ps1 (UTF-8, Chinese prompts).
setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%install.ps1"
if errorlevel 1 (
  echo.
  echo Installer failed. Please rerun it, or follow the manual steps in 使用说明.txt.
  pause
  exit /b 1
)
endlocal
`

const LAUNCH_BAT = `@echo off
rem dsh-TUI launcher (Windows): double-click to start the TUI.
setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%install.ps1" -LaunchOnly
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo dsh-tui could not start. Read the error above or rerun install.bat.
  pause
)
exit /b %EXIT_CODE%
`

const INSTALL_PS1 = `# dsh-TUI 一键安装脚本（Windows / PowerShell）
# 由整合包生成脚本自动产出，安装时自动获取 npm 最新版。
param([switch]$LaunchOnly)
$ErrorActionPreference = 'Stop'

function Step($m)  { Write-Host "\`n==> $m" -ForegroundColor Cyan }
function OK($m)    { Write-Host "    [OK] $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "    [!] $m" -ForegroundColor Yellow }
function Fail($m)  { Write-Host "    [x] $m" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
}

function Get-NodeVersion {
  $raw = & node --version 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
  try { return [version](($raw.TrimStart('v') -split '-')[0]) } catch { return $null }
}

$installedPrefixFile = Join-Path $PSScriptRoot 'installed-prefix.txt'
if ($LaunchOnly) {
  if (-not (Test-Path -LiteralPath $installedPrefixFile -PathType Leaf)) {
    Fail '请先运行本目录内的 install.bat 完成安装'
  }
  $prefix = [string](Get-Content -Raw -Encoding UTF8 -LiteralPath $installedPrefixFile)
  $prefix = $prefix.Trim()
  if (-not $prefix) { Fail '启动目录记录为空，请重新运行本目录内的 install.bat' }
  $dshTuiCmd = Join-Path $prefix 'dsh-tui.cmd'
  if (-not (Test-Path -LiteralPath $dshTuiCmd -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $prefix 'dsh.cmd') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $prefix 'pnpm.cmd') -PathType Leaf)) {
    Fail '已安装的命令不存在，请重新运行本目录内的 install.bat'
  }
  $env:Path = $prefix + ';' + $env:Path
  if (-not $env:DEEPSEEK_API_KEY) {
    $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
  }
  & $dshTuiCmd
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '   dsh-TUI 一键安装（Windows）' -ForegroundColor Cyan
Write-Host '   官网：https://dshtui.com' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan

# 1. Node.js
Step '检查 Node.js（需要 ^22.19 或 >=24）'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn '未检测到 Node.js，尝试用 winget 自动安装 LTS 版…'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    & winget install --id OpenJS.NodeJS.LTS --exact --silent \`
      --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Fail 'winget 安装失败，请到 https://nodejs.org/zh-cn 手动安装后重跑本脚本' }
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $node) {
    Fail '请先安装 Node.js（https://nodejs.org/zh-cn 下载 LTS 版），然后重新运行 install.bat'
  }
}
$nv = Get-NodeVersion
$nvText = if ($null -ne $nv) { $nv.ToString() } else { '未知' }
if (-not $nv -or -not (($nv.Major -eq 22 -and $nv.Minor -ge 19) -or $nv.Major -ge 24)) {
  Fail "Node.js 版本不兼容（当前 $nvText），需要 ^22.19 或 >=24；请升级后重跑"
}
OK "Node.js $($nv.ToString())"

# 2. pnpm（dsh profile 初始化需要 11+）
# npm's .cmd launchers work even when PowerShell blocks unsigned .ps1 shims.
$npmCmd = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Source
if (-not $npmCmd) {
  Fail '未找到 npm.cmd，请重新安装包含 npm 的 Node.js 后重跑'
}
# npm writes UTF-8 even when PowerShell 5.1's console uses another code page.
$previousEncoding = [System.Console]::OutputEncoding
try {
  [System.Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $prefix = & $npmCmd config get prefix 2>$null
  $prefixCode = $LASTEXITCODE
} finally { [System.Console]::OutputEncoding = $previousEncoding }
if ($prefixCode -ne 0 -or -not $prefix) { Fail '无法读取 npm 全局安装目录，请检查 npm 配置后重跑' }
$prefix = $prefix.Trim()
if (-not $prefix) { Fail 'npm 全局安装目录为空，请检查 npm 配置后重跑' }
$pnpmPath = Join-Path $prefix 'pnpm.cmd'
function Get-PnpmVersion($command) {
  if (-not (Test-Path -LiteralPath $command -PathType Leaf)) { return $null }
  try {
    $raw = & $command --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    return [version](($raw.Trim() -split '-')[0])
  } catch { return $null }
}
Step '检查 pnpm（需要 11+）'
$pv = Get-PnpmVersion $pnpmPath
if (-not $pv -or $pv.Major -lt 11) {
  Warn 'pnpm 不可用或版本过旧，正在安装兼容版本…'
  & $npmCmd install -g pnpm@${pnpmVersion}
  if ($LASTEXITCODE -ne 0) { Fail 'pnpm 安装失败，请手动执行：npm.cmd install -g pnpm@${pnpmVersion}' }
  $pv = Get-PnpmVersion $pnpmPath
}
if (-not $pv -or $pv.Major -lt 11) { Fail 'pnpm 11+ 仍不可用，请检查 npm 全局安装目录后重跑 install.bat' }
OK "pnpm $($pv.ToString())"
# Keep the installed pnpm and DSH first for profile initialization in children.
# This only changes this launch's environment, not Machine/User PATH settings.
$env:Path = $prefix + ';' + $env:Path

# 3. 全局安装 dsh CLI + dsh-TUI
Step '安装 @deepseek-ai/dsh 与 @deepseek-harness-tui/dsh-tui（首次较慢，请稍候）'
if ($prefix -match 'Program Files') {
  Warn "npm 全局目录在受保护路径（$prefix），若下面安装报权限错误，请右键 install.bat 以管理员身份运行，或执行：npm config set prefix \"\$env:APPDATA\\npm\""
}
$npmArgs = @('install', '-g', '@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui',
  '--fetch-timeout=60000', '--fetch-retries=1')
& $npmCmd @npmArgs
if ($LASTEXITCODE -ne 0) {
  Warn 'npm 官方源安装失败（国内网络常见），切换 npmmirror 镜像重试…'
  & $npmCmd @npmArgs --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) {
    Fail "安装失败。可手动执行：npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --registry=https://registry.npmmirror.com"
  }
}
OK 'dsh CLI 与 dsh-TUI 安装完成'

# 4. 校验
Step '校验安装'
$dshTuiCmd = Join-Path $prefix 'dsh-tui.cmd'
if (-not (Test-Path -LiteralPath $dshTuiCmd -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $prefix 'dsh.cmd') -PathType Leaf)) {
  Fail '本次安装目录中未找到 dsh 或 dsh-tui 命令，请保留上方安装输出并重新运行 install.bat'
}
& $dshTuiCmd --version
if ($LASTEXITCODE -ne 0) { Fail "dsh-tui 启动校验失败。请保留上方错误，并在 PowerShell 运行：& '$dshTuiCmd' doctor" }
OK 'dsh-tui 命令可用'
[IO.File]::WriteAllText($installedPrefixFile, $prefix, [Text.UTF8Encoding]::new($false))

# 5. DEEPSEEK_API_KEY
Step '检查 DEEPSEEK_API_KEY'
# An existing process value takes precedence; load a saved user value only when absent.
if (-not $env:DEEPSEEK_API_KEY) {
  $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
}
if (-not $env:DEEPSEEK_API_KEY -and [Console]::IsInputRedirected) {
  Warn '已跳过 API Key 输入。进入界面后可用 /provider 或 /login 配置。'
} elseif (-not $env:DEEPSEEK_API_KEY) {
  Warn '可粘贴 https://platform.deepseek.com 申请的 API Key；也可直接回车跳过，进入界面后配置账号。'
  $secureKey = Read-Host 'DEEPSEEK_API_KEY（输入隐藏）' -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($key) {
      [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $key, 'User')
      $env:DEEPSEEK_API_KEY = $key
      OK '已保存 API Key，本次启动立即生效'
    } else {
      Warn '已跳过。进入界面后可用 /provider 或 /login 配置。'
    }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $key = $null
    $secureKey.Dispose()
  }
} else {
  OK '已配置'
}

# 6. 完成
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  安装完成！启动方式：' -ForegroundColor Green
Write-Host '    双击本目录下的：启动 dsh-tui.bat（使用本次安装的版本）' -ForegroundColor Green
Write-Host '  请保留整个解压文件夹，供下次双击启动。' -ForegroundColor Green
Write-Host '  首次启动会自动初始化 profile，稍等片刻即可进入界面。' -ForegroundColor Green
Write-Host '  更新：重新运行本目录的 install.bat ｜ 文档：https://dshtui.com' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  按回车键立即启动；输入 N 后回车退出。' -ForegroundColor Green
if ([Console]::IsInputRedirected) { exit 0 }
$launch = Read-Host '现在启动'
if ($launch.Trim() -notmatch '^(n|no)$') {
  & $dshTuiCmd
  if ($LASTEXITCODE -ne 0) { Fail "首次启动失败。请保留上方错误，并在 PowerShell 运行：& '$dshTuiCmd' doctor" }
}
`

const INSTALL_SH = `#!/usr/bin/env bash
# dsh-TUI one-click installer (macOS / Linux)
# Generated by make-installer-bundle.mjs.
set -euo pipefail

step() { printf '\\n==> %s\\n' "$1"; }
ok()   { printf '    [OK] %s\\n' "$1"; }
warn() { printf '    [!] %s\\n' "$1" >&2; }
fail() { printf '    [x] %s\\n' "$1" >&2; exit 1; }

need_node() {
  command -v node >/dev/null 2>&1 || {
    warn '未检测到 Node.js。请先安装（macOS: brew install node；Debian/Ubuntu: sudo apt install nodejs npm；或用 nvm），然后重跑：sh install.sh'
    exit 1
  }
  local v major minor
  v=$(node --version | tr -d 'v' | cut -d- -f1)
  major=$(echo "$v" | cut -d. -f1)
  minor=$(echo "$v" | cut -d. -f2)
  if [ "$major" -ge 24 ]; then
    ok "Node.js $v"
  elif [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; then
    ok "Node.js $v"
  else
    fail "Node.js 版本过低（$v），需要 ^22.19 或 >=24。请升级后重跑：sh install.sh"
  fi
}

need_pnpm() {
  command -v pnpm >/dev/null 2>&1 || {
    warn '未检测到 pnpm，正在安装…'
    npm install -g pnpm || corepack enable pnpm || fail 'pnpm 安装失败，请手动执行：npm install -g pnpm'
  }
  ok 'pnpm 就绪'
}

install_pkgs() {
  step '安装 @deepseek-ai/dsh 与 @deepseek-harness-tui/dsh-tui（首次较慢，请稍候）'
  if ! npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui \\
    --fetch-timeout=60000 --fetch-retries=1; then
    warn 'npm 官方源安装失败（国内网络常见），切换 npmmirror 镜像重试…'
    npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui \\
      --registry=https://registry.npmmirror.com ||
      fail '安装失败。可手动执行：npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --registry=https://registry.npmmirror.com'
  fi
  ok 'dsh CLI 与 dsh-TUI 安装完成'
}

ensure_key() {
  step '检查 DEEPSEEK_API_KEY'
  if [ -n "\${DEEPSEEK_API_KEY:-}" ]; then
    ok '已配置'
    return
  fi
  warn '未配置 DEEPSEEK_API_KEY。请到 https://platform.deepseek.com 申请后粘贴（回车确认）：'
  read -r -p 'DEEPSEEK_API_KEY: ' key
  if [ -n "$key" ]; then
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      [ -f "$rc" ] || continue
      grep -q '^export DEEPSEEK_API_KEY=' "$rc" || \\
        printf '\\nexport DEEPSEEK_API_KEY=%s\\n' "'$key'" >> "$rc"
    done
    ok "已写入 ~/.bashrc / ~/.zshrc（重开终端生效）"
  else
    warn '已跳过。之后可手动：export DEEPSEEK_API_KEY="你的密钥"'
  fi
}

echo ''
echo '============================================'
echo '   dsh-TUI 一键安装（macOS / Linux）'
echo '   官网：https://dshtui.com'
echo '============================================'
need_node
need_pnpm
install_pkgs
step '校验安装'
command -v dsh-tui >/dev/null 2>&1 || fail '未找到 dsh-tui 命令，请重开终端后重跑：sh install.sh'
dsh-tui --version || true
ensure_key
echo ''
echo '============================================'
echo '  安装完成！启动方式：dsh-tui 或 dst'
echo '  首次启动会自动初始化 profile，稍等片刻即可进入界面。'
echo '  更新：dsh-tui update ｜ 文档：https://dshtui.com'
echo '============================================'
`

const README_TXT = `dsh-TUI 一键安装整合包（dsh-tui-setup）
====================================

这是什么？
  dsh-TUI 是 DeepSeek Harness 的交互式终端界面应用，支持全屏会话。
  本整合包检查 Node、准备 pnpm、安装 dsh CLI 和 dsh-TUI，并引导配置 API Key。
  Windows 缺少 Node 时会尝试 winget 安装；无法自动安装或版本过旧时会提示手动处理。

系统要求
  - Windows 10/11（推荐 Windows Terminal）或 macOS / Linux
  - 能联网（安装过程需要下载组件；国内网络会自动切换 npmmirror 镜像）

安装（三选一）
  Windows：
    双击 install.bat，按提示操作即可。
    若双击无反应，在文件夹地址栏输入 cmd 回车，然后运行：
      install.bat
  macOS / Linux：
    打开终端，进入解压目录，运行：
      sh install.sh
  手动安装（不想用整合包时）：
      npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

安装过程中会做什么
  1. 检查 Node.js（^22.19 或 >=24）；Windows 缺少时尝试 winget，过旧时提示升级；
  2. 安装 pnpm（Windows 会检查 11+，缺失或过旧时安装兼容版本）；
  3. 全局安装 @deepseek-ai/dsh 与 @deepseek-harness-tui/dsh-tui；
  4. 校验 dsh-tui 命令可用；
  5. Windows 下隐藏输入 API Key，保存后本次启动立即生效；也可跳过后在界面配置。
  6. Windows 安装完成后按回车即可立即启动。

启动
  Windows：双击"启动 dsh-tui.bat"；请保留整个解压文件夹。
    启动器绑定本次安装的目录，并让 DSH 与 pnpm 子进程使用该目录中的命令。
  macOS / Linux：运行：dsh-tui 或 dst
  首次启动会自动初始化 profile（dsh --profile dsh-tui 等价），稍等片刻进入界面。

API Key 从哪来？
  到 https://platform.deepseek.com 注册并创建 API Key（需实名认证）。
  也可以配置兼容端点：DEEPSEEK_BASE_URL + DEEPSEEK_API_KEY。

日常使用
  更新：Windows 重新运行 install.bat；macOS / Linux 运行 dsh-tui update；也可在界面使用 /update
  文档：https://dshtui.com ｜ GitHub：https://github.com/ccch1mneyyy/dsh-TUI
  卸载：npm uninstall -g @deepseek-harness-tui/dsh-tui @deepseek-ai/dsh
        并删除 %USERPROFILE%\\.dsh-tui 与 ~/.dsh/profiles/dsh-tui 目录

--------
English summary:
  One-command installer bundle for the dsh-TUI plugin (DeepSeek Harness TUI).
  Windows: double-click install.bat. macOS/Linux: sh install.sh.
  It checks Node, prepares pnpm, installs @deepseek-ai/dsh + @deepseek-harness-tui/dsh-tui,
  verifies the dsh-tui command, and guides DEEPSEEK_API_KEY setup.
  On Windows, missing Node is installed through winget when available; an unsupported
  Node version must be upgraded before rerunning the installer.
  On Windows, key input is hidden and takes effect immediately; press Enter to launch.
  You can skip the key and configure an account inside the TUI.
  Windows: keep the extracted folder and double-click 启动 dsh-tui.bat to use this install.
  macOS/Linux: dsh-tui (or dst).
`

// ─── 组装 ───────────────────────────────────────────────────────────────────

// 产物编码矩阵（ADR-0006）：行尾与 BOM 是每个宿主对文本的硬契约，在这里逐文件
// 显式声明；数据表不提供 `name → string` 简写——新增产物必须选择策略，而不是
// 默默继承某个默认值。
//   .bat → CRLF：cmd.exe 逐行解析，LF-only 会被误切（issue #1068）
//   .ps1 → UTF-8 with BOM：Windows PowerShell 5.1 默认按 ANSI 解码，无 BOM 中文乱码
//   .sh  → LF 无 BOM：POSIX 契约，行尾 0x0D 会污染 shebang / 参数
const files = {
  'install.bat': { text: INSTALL_BAT, eol: 'crlf', bom: false },
  'install.ps1': { text: INSTALL_PS1, eol: 'lf', bom: true },
  'install.sh': { text: INSTALL_SH, eol: 'lf', bom: false },
  '启动 dsh-tui.bat': { text: LAUNCH_BAT, eol: 'crlf', bom: false },
  '使用说明.txt': { text: README_TXT, eol: 'lf', bom: false },
}

// 策略 → 字节的唯一转换点：模板始终以 LF 书写（不在模板字面量里硬编码 \r\n），
// 这里按该文件自己的策略展开行尾、按需前置 BOM。CRLF 只作用于声明了 crlf 的文件，
// 不做全局统一替换——那会破坏 install.sh 的 POSIX LF 契约（ADR-0006）。
const EOL_SEQUENCE = { lf: '\n', crlf: '\r\n' }
const encodeBundleFile = ({ text, eol, bom }) => {
  if (!EOL_SEQUENCE[eol]) throw new Error(`未知行尾策略: ${eol}`)
  return (bom ? '\uFEFF' : '') + text.split(/\r?\n/).join(EOL_SEQUENCE[eol])
}

const stageDir = join(outDir, pkgDirName)
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
for (const [name, spec] of Object.entries(files)) {
  const content = encodeBundleFile(spec)
  writeFileSync(join(stageDir, name), content, 'utf8')
  // 字节数按最终写入内容统计：BOM 的 3 字节与 CRLF 的增量都计入，与用户解压后
  // 得到的文件逐字节一致。
  console.log(`  write ${name} (${Buffer.byteLength(content, 'utf8')} bytes)`)
}

// 打包 zip
const zipPath = join(outDir, zipName)
if (existsSync(zipPath)) rmSync(zipPath, { force: true })
if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${stageDir}' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: 'inherit' })
} else {
  execFileSync('zip', ['-r', zipPath, pkgDirName], { cwd: outDir, stdio: 'inherit' })
}

console.log(`\n整合包已生成：${zipPath}`)
console.log(`版本基准：${pkg.name}@${pkg.version}（安装时自动获取 npm 最新版）`)
