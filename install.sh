#!/bin/sh
# dsh-cc-tui 一键装入 DSH。
# 用法：sh install.sh            # 装入依赖链 + 打印挂载配置
#       sh install.sh --full     # 额外生成完整可跑的 ~/.dsh-cc/cordis.yml
# 幂等：重复执行安全（已 link 则跳过）。
set -eu

# 解析脚本真实路径（容忍符号链接调用）
SCRIPT=$0
while [ -L "$SCRIPT" ]; do
  TARGET=$(readlink "$SCRIPT")
  case $TARGET in
    /*) SCRIPT=$TARGET ;;
    *) SCRIPT=$(dirname "$SCRIPT")/$TARGET ;;
  esac
done
REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$SCRIPT")" && pwd)

# 1. 定位 harness 根（$DSH_HOME 或 ~/.dsh 下的 current 快照）
HARNESS="${DSH_HOME:-$HOME/.dsh}/source/current"
if [ ! -d "$HARNESS" ]; then
  echo "错误：找不到 DSH 快照 $HARNESS（可用 DSH_HOME 环境变量指定）" >&2
  exit 1
fi

# 2. 把包装进 harness 依赖链（配置树可解析；幂等——pnpm 处理重复 link）
(cd "$HARNESS" && pnpm add -w "link:$REPO_DIR")

# 3. 配置树挂载
if [ "${1:-}" = "--full" ]; then
  DSH_CC_DIR="${DSH_CC_DIR:-$HOME/.dsh-cc}"
  mkdir -p "$DSH_CC_DIR"
  cp "$REPO_DIR/cordis.yml" "$DSH_CC_DIR/cordis.yml"
  echo "已生成 $DSH_CC_DIR/cordis.yml（完整 agent 树，含 cc-tui 挂载）。"
  echo "启动：dsh --config \"$DSH_CC_DIR/cordis.yml\"（Windows 可直接用 dsh-cc.cmd）"
fi

# 4. 技能（CC 内置技能命令 /audit /bug /practice /review /pr_comments
#    /release-notes /vuln-check 的 DSH 版）装到 ~/.dsh/skills，供 skill-local 发现。
SKILLS_DST="${DSH_CC_SKILLS:-$HOME/.dsh/skills}"
if [ -d "$REPO_DIR/skills" ]; then
  mkdir -p "$SKILLS_DST"
  for skill_dir in "$REPO_DIR"/skills/*/; do
    [ -d "$skill_dir" ] || continue
    name=$(basename "$skill_dir")
    mkdir -p "$SKILLS_DST/$name"
    cp "$skill_dir/SKILL.md" "$SKILLS_DST/$name/SKILL.md"
  done
  echo "已装入技能 → $SKILLS_DST（audit/bug/practice/review/pr_comments/release-notes/vuln-check）"
fi

if [ "${1:-}" != "--full" ]; then
  echo ""
  echo "已装入依赖链。在你的 DSH 配置树（cordis.yml / config.yaml）里挂载 cc-tui，"
  echo "最小片段（依赖官方 llm/bash/fs/persistence/compact/spine 插件）："
  echo ""
  cat <<'EOF'
- id: cc-tui
  name: '@deepseek-ai/dsh-cc-tui'
  config:
    provider: deepseek-official
    effort: max
EOF
  echo ""
  echo "完整可跑示例见本仓库 cordis.yml；也可运行：sh install.sh --full"
fi
echo "安装完成。请重启 dsh（Ctrl+C 后重新运行）生效。"
