@echo off
rem dsh-tui: launch dsh-TUI through the official dsh CLI profile boot.
rem Use the shared launcher for CLI resolution, profile setup and --resume.
rem DSH_TUI_DSH_BIN pins the CLI; recognised desktop Electron shims are skipped
rem when another CLI is available on PATH (issue #1388).
rem Requires node on PATH. The profile lives under $DSH_HOME (default ~/.dsh).
rem NODE_ENV defaults to production: the React renderer's development build
rem records unbounded performance.measure() entries and OOMs long sessions.
rem WORKSPACE: 工作目录（默认当前目录；可用 DSH_TUI_WORKSPACE 环境变量覆盖）。
setlocal
if not defined NODE_ENV set "NODE_ENV=production"
set "WORKSPACE=%DSH_TUI_WORKSPACE%"
if "%WORKSPACE%"=="" set "WORKSPACE=%CD%"
cd /d "%WORKSPACE%"

node "%~dp0bin\dsh-tui.js" %*
exit /b %errorlevel%
