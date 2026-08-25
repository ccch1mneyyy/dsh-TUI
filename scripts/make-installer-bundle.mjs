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
)
endlocal
`

const LAUNCH_BAT = `@echo off
rem dsh-TUI launcher (Windows): double-click to start the TUI.
where dsh-tui >nul 2>&1
if errorlevel 1 (
  echo dsh-tui was not found. Please run install.bat first.
  pause
  exit /b 1
)
dsh-tui
pause
`

const INSTALL_PS1 = `# dsh-TUI 一键安装脚本（Windows / PowerShell）
# 由整合包生成脚本自动产出，安装时自动获取 npm 最新版。
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
if (-not $nv -or ($nv -lt [version]'22.19' -and $nv.Major -lt 24)) {
  Fail "Node.js 版本过低（当前 $nvText），请升级到 22.19+ 或 24+（winget upgrade OpenJS.NodeJS.LTS）后重跑"
}
OK "Node.js $($nv.ToString())"

# 2. pnpm（dsh profile 初始化需要）
Step '检查 pnpm'
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Warn '未检测到 pnpm，正在安装…'
  & npm install -g pnpm
  if ($LASTEXITCODE -ne 0) {
    Warn 'npm 安装 pnpm 失败，尝试 corepack…'
    & corepack enable pnpm
    if ($LASTEXITCODE -ne 0) { Fail 'pnpm 安装失败，请手动执行：npm install -g pnpm' }
  }
}
OK 'pnpm 就绪'

# 3. 全局安装 dsh CLI + dsh-TUI
Step '安装 @deepseek-ai/dsh 与 @deepseek-harness-tui/dsh-tui（首次较慢，请稍候）'
$prefix = (& npm config get prefix 2>$null).Trim()
if ($prefix -match 'Program Files') {
  Warn "npm 全局目录在受保护路径（$prefix），若下面安装报权限错误，请右键 install.bat 以管理员身份运行，或执行：npm config set prefix \"\$env:APPDATA\\npm\""
}
$npmArgs = @('install', '-g', '@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui',
  '--fetch-timeout=60000', '--fetch-retries=1')
& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
  Warn 'npm 官方源安装失败（国内网络常见），切换 npmmirror 镜像重试…'
  & npm @npmArgs --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) {
    Fail "安装失败。可手动执行：npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui --registry=https://registry.npmmirror.com"
  }
}
OK 'dsh CLI 与 dsh-TUI 安装完成'

# 4. 校验
Step '校验安装'
Refresh-Path
if (-not (Get-Command dsh-tui -ErrorAction SilentlyContinue)) {
  Fail '未找到 dsh-tui 命令。请关闭本窗口、重新打开终端后再次运行 install.bat'
}
& dsh-tui --version
if ($LASTEXITCODE -ne 0) { Warn '版本校验未通过，但安装可能已成功，请用 dsh-tui 命令验证' }
OK 'dsh-tui 命令可用'

# 5. DEEPSEEK_API_KEY
Step '检查 DEEPSEEK_API_KEY'
$hasKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') -or
          [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'Process')
if (-not $hasKey) {
  Warn '未配置 DEEPSEEK_API_KEY。请到 https://platform.deepseek.com 申请 API Key 后粘贴到下面（输入后回车）：'
  $key = Read-Host 'DEEPSEEK_API_KEY'
  if ($key) {
    [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $key.Trim(), 'User')
    OK '已写入用户环境变量（永久生效）'
    Warn '请关闭本窗口并重新打开终端，配置才会在当前会话生效'
  } else {
    Warn '已跳过。之后可手动配置：setx DEEPSEEK_API_KEY "你的密钥"'
  }
} else {
  OK '已配置'
}

# 6. 完成
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  安装完成！启动方式：' -ForegroundColor Green
Write-Host '    1. 重新打开终端，运行：dsh-tui' -ForegroundColor Green
Write-Host '    2. 或双击本目录下的：启动 dsh-tui.bat' -ForegroundColor Green
Write-Host '  首次启动会自动初始化 profile，稍等片刻即可进入界面。' -ForegroundColor Green
Write-Host '  更新：dsh-tui update ｜ 文档：https://dshtui.com' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Read-Host '按回车键退出'
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
echo '  安装完成！启动方式：dsh-tui'
echo '  首次启动会自动初始化 profile，稍等片刻即可进入界面。'
echo '  更新：dsh-tui update ｜ 文档：https://dshtui.com'
echo '============================================'
`

const README_TXT = `dsh-TUI 一键安装整合包（dsh-tui-setup）
====================================

这是什么？
  dsh-TUI 是 DeepSeek Harness 的终端界面插件（Claude Code 风格全屏 TUI）。
  本整合包把"装 Node、装 pnpm、装 dsh CLI 和 dsh-TUI、配 API Key"全部自动化，
  解压后一条命令即可完成安装，无需手动敲多行命令。

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
  1. 检查 Node.js（^22.19 或 >=24），没有则自动安装（Windows 用 winget）；
  2. 安装 pnpm；
  3. 全局安装 @deepseek-ai/dsh 与 @deepseek-harness-tui/dsh-tui；
  4. 校验 dsh-tui 命令可用；
  5. 检查 DEEPSEEK_API_KEY，未配置时引导你粘贴并持久化保存。

启动
  Windows：双击"启动 dsh-tui.bat"；或打开终端运行：dsh-tui
  macOS / Linux：运行：dsh-tui
  首次启动会自动初始化 profile（dsh --profile dsh-tui 等价），稍等片刻进入界面。

API Key 从哪来？
  到 https://platform.deepseek.com 注册并创建 API Key（需实名认证）。
  也可以配置兼容端点：DEEPSEEK_BASE_URL + DEEPSEEK_API_KEY。

日常使用
  更新：dsh-tui update（或 /update）
  文档：https://dshtui.com ｜ GitHub：https://github.com/ccch1mneyyy/dsh-TUI
  卸载：npm uninstall -g @deepseek-harness-tui/dsh-tui @deepseek-ai/dsh
        并删除 %USERPROFILE%\\.dsh-tui 与 ~/.dsh/profiles/dsh-tui 目录

--------
English summary:
  One-command installer bundle for the dsh-TUI plugin (DeepSeek Harness TUI).
  Windows: double-click install.bat. macOS/Linux: sh install.sh.
  It installs Node (if missing), pnpm, @deepseek-ai/dsh + @deepseek-harness-tui/dsh-tui,
  verifies the dsh-tui command, and guides DEEPSEEK_API_KEY setup.
  Launch with: dsh-tui
`

// ─── 组装 ───────────────────────────────────────────────────────────────────

const files = {
  'install.bat': INSTALL_BAT,
  'install.ps1': INSTALL_PS1,
  'install.sh': INSTALL_SH,
  '启动 dsh-tui.bat': LAUNCH_BAT,
  '使用说明.txt': README_TXT,
}

const stageDir = join(outDir, pkgDirName)
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(stageDir, name), content, 'utf8')
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
