#!/bin/sh
# Build the dsh-tui external plugin: compile src/ → lib/types/ (JS +
# declarations) with the DSH checkout's TypeScript. Dependency resolution
# mirrors dsh-vision: node_modules holds symlinks into the checkout, so tsc
# type-checks against the same vendored/workspace packages the running dsh
# ships. Requires a DSH checkout ($DSH_HOME/source/current, ~/.dsh/..., or
# the `dsh` bin resolving into one).
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

# --- Locate the DSH checkout -------------------------------------------
CHECKOUT=""
if [ -n "${DSH_HOME:-}" ] && [ -d "$DSH_HOME/source/current" ]; then
  CHECKOUT="$DSH_HOME/source/current"
elif [ -d "${HOME:-}/.dsh/source/current" ]; then
  CHECKOUT="$HOME/.dsh/source/current"
elif command -v dsh >/dev/null 2>&1; then
  DSH_BIN=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
  CHECKOUT=$(cd "$(dirname "$DSH_BIN")/../../.." 2>/dev/null && pwd)
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the DSH checkout (set DSH_HOME or put dsh on PATH)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  mkdir -p "$(dirname "node_modules/$1")"
  ln -sfn "$target" "node_modules/$1"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@standard-schema
# @types are installed by `npm install` (devDependencies); only link the
# checkout's copy when the repo was never installed.
if [ ! -e node_modules/@types ]; then
  ln -sfn "$CHECKOUT/node_modules/@types" node_modules/@types
fi
link_pkg cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-commands packages/ui/commands
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-session packages/core/session

# @standard-schema/spec: external npm types referenced by cordis/schemastery
# declarations, hoisted only inside the pnpm store.
STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  ln -sfn "$STD_SCHEMA/node_modules/@standard-schema/spec" node_modules/@standard-schema/spec
else
  echo "build: @standard-schema/spec not found in pnpm store; skipLibCheck may still cover it" >&2
fi

echo "=== Compiling src → lib/types ($("$TSC" --version)) ==="
"$TSC" -p tsconfig.json
# Incremental build cache is a build-time artifact — keep it out of the
# published lib/.
rm -f lib/tsconfig.tsbuildinfo
echo "=== Build complete: lib/types/ ==="
