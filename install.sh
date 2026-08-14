#!/bin/sh
# dsh-cc-tui 一键安装（npm 版）。
# 走官方 dsh CLI 的 profile 插件机制：`add` 自动初始化 profile（首层
# dsh-base），pnpm 安装后按 dsh.bundle.patch 元数据把本包追加为 bundle
# 层；本包的 patch 会一并 insert 工作状态行（dsh-working-activity，作为
# npm 依赖自动带入），一条命令全部就绪。
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

dsh plugin --profile cc-tui add dsh-cc-tui
echo
echo "安装完成。启动：dsh --profile cc-tui"
echo "Windows 也可以用仓库根目录的 dsh-cc.cmd（--resume 恢复上次会话）。"
echo
echo "注意：不要再对同一 profile 单独 add dsh-working-activity——它已随"
echo "cc-tui 的补丁层自动挂载，重复 add 会产生重复行。想调参（如"
echo "publishIntervalMs）在 \$DSH_HOME/profiles/cc-tui/cordis.patch.yml 按 id 覆盖："
echo "  - id: working-activity"
echo "    config:"
echo "      publishIntervalMs: 500"
