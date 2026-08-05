@echo off
rem dsh-cc: launch the cc-tui front door (ported Claude Code TUI).
rem Copy this file into any PATH directory (e.g. D:\node) and run "dsh-cc".
rem Requires: node >= 22.19 and a global tsx (npm install -g tsx).
rem --tsconfig pins the plugin's own tsconfig so tsx never re-maps the
rem workspace imports through the root tsconfig's source paths.
rem DEEPSEEK_API_KEY resolution: user environment (setx) wins; run.ts falls
rem back to the workspace .env.
rem dsh-cc --resume opens the session marked by /resume.
setlocal
set "WORKSPACE=D:\code\projects\test-ccch1mneyyy"
cd /d "%WORKSPACE%"

rem Prefer a PATH node; fall back to the harness-side install.
where node >nul 2>nul
if %errorlevel% equ 0 (
  set "NODE=node"
) else (
  set "NODE=D:\node\node.exe"
)

if /i "%~1"=="--resume" (
  rem Feed the /resume-marked session id into the leaf config.
  if exist "%USERPROFILE%\.dsh-cc\resume.txt" (
    set /p DSH_CC_RESUME_SESSION=<"%USERPROFILE%\.dsh-cc\resume.txt"
  )
)

tsx --tsconfig "%WORKSPACE%\packages\ui\cc-tui\tsconfig.json" "%WORKSPACE%\packages\ui\cc-tui\scripts\run.ts"
endlocal
