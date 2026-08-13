#!/bin/sh
# dsh-cc-tui 一键安装（npm 版）。
# 走官方 dsh CLI 的 profile 插件机制：组合 dsh-base 层 + 本包的
# cordis.patch.yml 补丁层。无需 DSH 源码快照，无需 workspace 链接。
set -eu

if ! command -v dsh >/dev/null 2>&1; then
  echo "未检测到 dsh CLI。先安装官方客户端：" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

dsh plugin --profile cc-tui add dsh-cc-tui
echo "安装完成。启动：dsh --profile cc-tui"
