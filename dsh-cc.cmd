@echo off
rem dsh-cc: launch cc-tui through the official dsh profile boot.
rem Profile: DSH_HOME/profiles/cc-tui composes dsh-base + dsh-cc-tui bundle.
rem Requires: node >= 22.19 and a global tsx (npm install -g tsx).
rem --tsconfig pins the ROOT tsconfig so tsx resolves workspace imports
rem through source-plane paths. cc-tui loads via Loader exports to lib,
rem so rebuild after src/ changes (pnpm run build).
rem DEEPSEEK_API_KEY: user env (setx) wins; run.ts falls back to .env.
rem dsh-cc --resume opens the session marked by /resume.
rem DSH_HOME pins the profile root to .dsh-cc (existing sessions).
setlocal
set "NODE_ENV=production"
rem WORKSPACE: DSH 主仓库路径（默认当前目录；可用 DSH_CC_WORKSPACE 环境变量覆盖）
set "WORKSPACE=%DSH_CC_WORKSPACE%"
if "%WORKSPACE%"=="" set "WORKSPACE=%CD%"
set "DSH_HOME=%USERPROFILE%\.dsh-cc"
cd /d "%WORKSPACE%"

where node >nul 2>nul
if %errorlevel% equ 0 (
  set "NODE=node"
) else (
  rem 找不到 node：请确认 node 已加入 PATH，或把下面路径改成你自己的 node
  set "NODE=%ProgramFiles%\nodejs\node.exe"
)

if /i "%~1"=="--resume" (
  if exist "%USERPROFILE%\.dsh-cc\resume.txt" (
    set /p DSH_CC_RESUME_SESSION=<"%USERPROFILE%\.dsh-cc\resume.txt"
  )
)

tsx --tsconfig "%WORKSPACE%\tsconfig.json" "%WORKSPACE%\packages\ui\cc-tui\scripts\run.ts"
endlocal
