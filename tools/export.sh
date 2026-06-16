#!/usr/bin/env bash
# 导出 steward「框架 + 方法论」为一份干净、可分享的包（不含你的项目内容）。
# 用法：bash tools/export.sh [输出目录]   默认 ~/Desktop/steward-export
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Desktop/steward-export}"
STAGE="$OUT/steward"

echo "▶ 准备干净副本 → $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/tools" "$STAGE/dashboard"

# 框架（控制台 + 脚手架模板 + 方法论）。不带 steward 自己 pams 味的 README / ai-team 旧文档
cp "$ROOT/dashboard/index.html"  "$STAGE/dashboard/"
cp "$ROOT/tools/server.mjs" "$ROOT/tools/start.sh" "$ROOT/tools/new-project.sh" "$ROOT/tools/export.sh" "$STAGE/tools/"
cp -R "$ROOT/templates" "$STAGE/templates"   # board.mjs 随 templates/ 走（每个项目一份）

# CLAUDE.md：复制后清空「当前受管项目」表 + 去掉 pams 举例
node -e '
const fs=require("fs");
let s=fs.readFileSync(process.argv[1],"utf8").split("\n");
const out=[]; let inTbl=false;
for(const l of s){
  if(/^##\s*当前受管项目/.test(l)){ inTbl=true; out.push(l,"| id | 名称 | 路径 |","|---|---|---|","| _（空：用控制台「新增项目」或 `bash tools/new-project.sh` 纳管）_ |  |  |"); continue; }
  if(inTbl){ if(/^\s*\|/.test(l)) continue; inTbl=false; }
  out.push(l.replace(/（如 pams 在 `[^`]*`）/g,"").replace(/pams 在 `[^`]*`/g,"对应项目目录"));
}
fs.writeFileSync(process.argv[2], out.join("\n"));
' "$ROOT/CLAUDE.md" "$STAGE/CLAUDE.md"

# 通用化：去掉 pams 专属命名，让导出包对所有人通用
[ -f "$STAGE/templates/.claude/agents/pams-dev.md" ] && mv "$STAGE/templates/.claude/agents/pams-dev.md" "$STAGE/templates/.claude/agents/dev.md"
grep -rl 'pams-dev' "$STAGE/templates" 2>/dev/null | while read -r f; do LC_ALL=C sed -i '' 's/pams-dev/dev/g' "$f"; done
# 防御性清掉残留本机绝对路径
grep -rIl '/Users/' "$STAGE" 2>/dev/null | while read -r f; do LC_ALL=C sed -i '' 's#/Users/[^ `)、，]*#<本机路径>#g' "$f"; done

# 注册表不在工具里（已隔离到 ~/.steward/projects.json，运行时自动建空表），所以导出包天生干净，无需清理。
# 清杂物（本地设置 / 系统文件不导出）
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true
rm -rf "$STAGE/.claude" 2>/dev/null || true

# 上手说明
cat > "$STAGE/快速上手.md" <<'MD'
# Steward 控制台 · 快速上手

> 多项目研发中枢：一处纳管多个项目，按 **spec 驱动**开发，导入存量项目自动建规约基线。

## 依赖
- Node.js（跑控制台，零三方依赖）
- ttyd + tmux（内嵌终端、会话持久化）：`brew install ttyd tmux`

## 启动
```bash
bash tools/start.sh        # → http://127.0.0.1:5178
```

## 用法
1. 控制台「新增项目」填 id/名称/路径（已有代码=导入，只补团队文件不动代码）。
2. 给项目开终端窗口，跑 `/scan` 把现有代码逆向抽成 `docs/specs/<ID>.md` 规约基线（按功能模块、便宜模型）。
3. 之后新需求/改动走 `/spec`·`/build`·`/fix`：先拆条 + 影响面分析 → 改 spec → 实现 → 看板验收。
4. 方法论见各项目自带的 `CLAUDE.md`（源自 `templates/CLAUDE.md`）。

> 这是「框架 + 方法论」分享包，不含任何业务项目内容。
MD

echo "▶ 打包"
( cd "$OUT" && tar -czf steward-export.tgz steward )
echo ""
echo "✓ 导出完成："
echo "    目录：$STAGE"
echo "    压缩包：$OUT/steward-export.tgz"
echo "  别人拿到后：解压 → cd steward → brew install ttyd tmux → bash tools/start.sh"
