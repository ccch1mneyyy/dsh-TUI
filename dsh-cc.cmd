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
set "WORKSPACE=D:\code\projects\test-ccch1mneyyy"
set "DSH_HOME=%USERPROFILE%\.dsh-cc"
cd /d "%WORKSPACE%"

where node >nul 2>nul
if %errorlevel% equ 0 (
  set "NODE=node"
) else (
  set "NODE=D:\node\node.exe"
)

if /i "%~1"=="--resume" (
  if exist "%USERPROFILE%\.dsh-cc\resume.txt" (
    set /p DSH_CC_RESUME_SESSION=<"%USERPROFILE%\.dsh-cc\resume.txt"
  )
)

tsx --tsconfig "%WORKSPACE%\tsconfig.json" "%WORKSPACE%\packages\ui\cc-tui\scripts\run.ts"
endlocal
