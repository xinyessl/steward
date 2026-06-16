#!/usr/bin/env bash
# 一键启动 AI 研发团队控制台（多项目 + 流式对话 + 内嵌终端）
# 用法：bash tools/start.sh      （在项目根或任意目录均可，脚本会自行定位）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-5178}"
export CLAUDE_EXTRA="${CLAUDE_EXTRA:---dangerously-skip-permissions}"  # 本地放开权限，让对话能自动改文件/起子 agent

echo "▶ 清理旧实例…"
pkill -f "tools/server.mjs" 2>/dev/null || true
pkill -f "ttyd -W -i 127.0.0.1" 2>/dev/null || true
sleep 1

# ttyd 检查（内嵌终端用）
if command -v ttyd >/dev/null 2>&1 || [ -x /opt/homebrew/bin/ttyd ] || [ -x /usr/local/bin/ttyd ]; then
  echo "✓ ttyd 已就绪 —— 面板「终端」Tab 可用"
else
  echo "⚠ 未检测到 ttyd —— 内嵌终端不可用（其余功能正常）。安装：brew install ttyd"
fi

echo "▶ 启动控制台 → http://127.0.0.1:${PORT}"
echo "  (Ctrl+C 停止)"
echo
PORT="$PORT" exec node tools/server.mjs
