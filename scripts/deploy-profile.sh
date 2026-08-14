#!/bin/sh
# deploy-profile.sh — 把仓库修复后的编译产物部署到 dsh 的 cc-tui profile，
# 并安装 dsh-cc 启动器（macOS/Linux）。幂等，可重复执行。
#
# 背景：`dsh --profile cc-tui` 运行的是 $DSH_HOME/profiles/cc-tui 下 npm 安装的
# dsh-cc-tui 包（非仓库源码）。本脚本把仓库已构建的 lib/ 与 cordis.patch.yml
# 同步进该包，让修复（--resume/-c 参数、位置参数 prompt、正确退出提示）
# 立即生效；末尾的入口 import 冒烟在真实模块解析环境下验证部署完整性。
#
# 用法: sh scripts/deploy-profile.sh
# 测试钩子（默认走真实路径，仅测试时覆盖）：
#   DSH_PROFILE_DIR=<profile 目录>   # 默认为 ${DSH_HOME:-$HOME/.dsh}/profiles/cc-tui
#   DSH_CC_BIN_DIR=<bin 目录>        # 默认为 $HOME/.local/bin
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-${DSH_HOME:-$HOME/.dsh}/profiles/cc-tui}"
PKG_DIR="$PROFILE_DIR/node_modules/dsh-cc-tui"
BIN_DIR="${DSH_CC_BIN_DIR:-$HOME/.local/bin}"

if [ ! -d "$PKG_DIR" ]; then
  echo "错误: 未找到 $PKG_DIR" >&2
  echo "请先安装 profile: dsh plugin --profile cc-tui add dsh-cc-tui" >&2
  exit 1
fi

echo "==> 同步 lib 与 cordis.patch.yml 到 $PKG_DIR"
rsync -a --delete "$REPO_ROOT/lib/" "$PKG_DIR/lib/"
rsync -a "$REPO_ROOT/cordis.patch.yml" "$PKG_DIR/cordis.patch.yml"

echo "==> 安装 dsh-cc 启动器到 $BIN_DIR"
if [ -f "$REPO_ROOT/dsh-cc" ]; then
  mkdir -p "$BIN_DIR"
  install -m 755 "$REPO_ROOT/dsh-cc" "$BIN_DIR/dsh-cc"
  case ":$PATH:" in
    *":$BIN_DIR:"*) echo "    $BIN_DIR 已在 PATH" ;;
    *) echo "    警告: $BIN_DIR 不在 PATH，需自行加入（export PATH=\"$BIN_DIR:\$PATH\"）" ;;
  esac
fi

echo "==> 验证部署"
fail=0
[ -f "$PKG_DIR/lib/types/args.js" ] && echo "  PASS: args.js 已部署" || { echo "  FAIL: args.js 缺失"; fail=1; }
if grep -q "dsh --profile cc-tui --resume" "$PKG_DIR/lib/types/plugin.js"; then
  echo "  PASS: plugin.js 已包含新退出提示"
else
  echo "  FAIL: plugin.js 仍是旧退出提示"; fail=1
fi
if grep -q "parseCcTuiArgs" "$PKG_DIR/lib/types/plugin.js"; then
  echo "  PASS: plugin.js 已包含参数解析"
else
  echo "  FAIL: plugin.js 缺少参数解析"; fail=1
fi
if grep -q "agent-presets" "$PKG_DIR/cordis.patch.yml"; then
  echo "  PASS: cordis.patch.yml 已同步为仓库当前版本"
else
  echo "  FAIL: cordis.patch.yml 仍是旧版"; fail=1
fi
if [ -x "$BIN_DIR/dsh-cc" ]; then
  echo "  PASS: dsh-cc 启动器可执行"
else
  echo "  FAIL: dsh-cc 启动器不可执行"; fail=1
fi

echo "  -- 入口 import 冒烟（真实模块解析，等价于启动时加载）"
if (cd "$PKG_DIR" && node --input-type=module -e "await import('./lib/types/index.js')" >/dev/null 2>&1); then
  echo "  PASS: dsh-cc-tui 入口加载成功"
else
  echo "  FAIL: dsh-cc-tui 入口加载失败（依赖缺失或产物不匹配，检查 pnpm install 状态）"; fail=1
fi
[ "$fail" -eq 0 ] || { echo "部署验证失败，请检查后重试" >&2; exit 1; }

echo
echo "部署完成（lib 与 patch 已是仓库当前版本产物；npm 元数据版本号不变）。用法："
echo "  dsh --profile cc-tui                      # 新会话"
echo "  dsh --profile cc-tui \"run the tests\"     # 新会话 + 初始 prompt"
echo "  dsh --profile cc-tui -c                   # 恢复上次会话"
echo "  dsh --profile cc-tui --resume <id>        # 恢复指定会话"
echo "  dsh-cc [同上参数]                         # 等价启动器"
echo
echo "注意: 之后若执行 dsh plugin --profile cc-tui update（或 pnpm install），"
echo "      会按 package.json（^0.2.1）重新拉取 npm 包覆盖本部署；届时重跑本脚本即可。"
