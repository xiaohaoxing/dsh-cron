#!/usr/bin/env bash
# Link the framework packages this plugin imports into the repo's
# node_modules, so the plugin loads from ANY install location (a bare clone
# has no node_modules — that missing-link failure surfaces as
# ERR_MODULE_NOT_FOUND for '@deepseek-ai/dsh-tools' on harness boot).
#
# Usage:
#   bash scripts/setup-deps.sh                  # auto-detect the desktop app
#   DSH_APP_DIR=/path/to/dsh bash scripts/setup-deps.sh   # custom install
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

detect() {
  local cand="$1"
  if [ -d "$cand/node_modules/@deepseek-ai/dsh-tools" ]; then
    printf '%s' "$cand/node_modules"
    return 0
  fi
  return 1
}

app="/Applications/DSH Desktop.app/Contents/Resources/app"
src=""
if [ -n "${DSH_APP_DIR:-}" ]; then
  src="$(detect "$DSH_APP_DIR")" || { echo "DSH_APP_DIR 下未找到 @deepseek-ai/dsh-tools: $DSH_APP_DIR" >&2; exit 1; }
elif detect "$app" >/dev/null 2>&1; then
  src="$(detect "$app")"
elif command -v dsh >/dev/null 2>&1; then
  bin_dir="$(dirname "$(command -v dsh)")"
  parent="$(dirname "$bin_dir")"
  if detect "$parent" >/dev/null 2>&1; then
    src="$(detect "$parent")"
  fi
fi
if [ -z "$src" ]; then
  echo "未找到 DSH 安装。请设置 DSH_APP_DIR 指向含 node_modules/@deepseek-ai/dsh-tools 的 DSH 应用目录。" >&2
  exit 1
fi

mkdir -p "$repo/node_modules/@deepseek-ai"
for pkg in dsh-tools cordis; do
  target="$repo/node_modules/@deepseek-ai/$pkg"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "已存在: $target（跳过）"
  else
    ln -s "$src/@deepseek-ai/$pkg" "$target"
    echo "链接: $target -> $src/@deepseek-ai/$pkg"
  fi
done
echo
echo "依赖就绪（来自 $src）。接下来按 INSTALL.md 继续："
echo "  ln -sfn \"$repo\" \"\$HOME/.dsh/profiles/node_modules/@dsh/cron\""
echo "  并在 cordis.patch.yml 挂载 @dsh/cron 后重启 harness。"
