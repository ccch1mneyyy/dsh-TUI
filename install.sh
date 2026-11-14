#!/bin/sh
# dsh-TUI 一键安装（npm 版）。
# 通过官方 dsh CLI 初始化 profile 并安装市场管理入口。
# 首次运行 dsh-tui 时会下载所需运行时并准备完整 TUI 组合；
# 工作状态行（dsh-working-activity）由该运行时组合挂载。
# 无需 DSH 源码快照，无需 workspace 链接。
set -eu

if ! command -v dsh >/dev/null 2>&1; then
  echo "未检测到 dsh CLI。先安装官方客户端：" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未检测到 pnpm。dsh plugin 把安装转发给 pnpm，请先安装：" >&2
  echo "  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）" >&2
  exit 1
fi

dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
echo
echo "安装完成。运行 dsh-tui 启动；首次启动会下载并准备运行时（需要网络和 pnpm）。"
echo "若未全局安装 dsh-tui，运行："
echo "  node \"\${DSH_HOME:-\$HOME/.dsh}/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js\""
echo "Windows 也可以用仓库根目录的 dsh-tui.cmd（--resume 恢复上次会话）。"
echo
echo "注意：不要再对同一 profile 单独 add dsh-working-activity——它已随"
echo "dsh-tui 的运行时组合自动挂载，重复 add 会产生重复行。想调参（如"
echo "publishIntervalMs）在 \$DSH_HOME/profiles/dsh-tui/cordis.patch.yml 按 id 覆盖："
echo "  - id: working-activity"
echo "    config:"
echo "      publishIntervalMs: 500"
