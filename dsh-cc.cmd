@echo off
rem dsh-cc: launch cc-tui through the official dsh CLI profile boot.
rem Equivalent to: dsh --profile cc-tui <args>
rem   --resume: read ~/.dsh-cc/resume.txt and feed it to the TUI as
rem             DSH_CC_RESUME_SESSION (the TUI writes the chosen session
rem             id there on /resume; see src/sessionHistory.ts).
rem Prereq: dsh CLI on PATH (npm install -g @deepseek-ai/dsh). The profile
rem         is created by `dsh plugin --profile cc-tui add dsh-cc-tui`
rem         under $DSH_HOME/profiles/cc-tui (default ~/.dsh), so this
rem         launcher must NOT pin DSH_HOME.
rem NODE_ENV defaults to production: the React renderer's development build
rem records unbounded performance.measure() entries and OOMs long sessions.
rem WORKSPACE: 工作目录（默认当前目录；可用 DSH_CC_WORKSPACE 环境变量覆盖）。
setlocal
if not defined NODE_ENV set "NODE_ENV=production"
set "WORKSPACE=%DSH_CC_WORKSPACE%"
if "%WORKSPACE%"=="" set "WORKSPACE=%CD%"
cd /d "%WORKSPACE%"

where dsh >nul 2>nul
if errorlevel 1 (
  echo [dsh-cc] 未找到 dsh CLI。请先安装：npm install -g @deepseek-ai/dsh 1>&2
  exit /b 1
)

set "ARGS="
:parse
if "%~1"=="" goto :run
if /i "%~1"=="--resume" (
  if exist "%USERPROFILE%\.dsh-cc\resume.txt" (
    set /p DSH_CC_RESUME_SESSION=<"%USERPROFILE%\.dsh-cc\resume.txt"
  )
) else (
  set "ARGS=%ARGS% "%~1""
)
shift
goto :parse

:run
@dsh --profile cc-tui %ARGS%
endlocal
