#!/usr/bin/env bash
# 新增一个项目到 AI 研发团队（复制团队文件骨架 + 注册到 projects.json）
# 用法: bash tools/new-project.sh <id> <名称> <项目绝对路径>
# 例:   bash tools/new-project.sh shop 商城系统 /path/to/your/project
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID="$1"; NAME="$2"; DEST="$3"
if [ -z "$ID" ] || [ -z "$NAME" ] || [ -z "$DEST" ]; then
  echo "用法: bash tools/new-project.sh <id> <名称> <项目绝对路径>"; exit 1
fi

echo "▶ 准备项目目录：$DEST"
mkdir -p "$DEST/.claude/agents" "$DEST/.claude/commands" "$DEST/docs/specs" "$DEST/docs/.state" "$DEST/tools"

echo "▶ 复制脚手架模板（templates/，已存在的不覆盖）"
TPL="$ROOT/templates"
cp -n "$TPL/CLAUDE.md"                   "$DEST/CLAUDE.md"               2>/dev/null || true
cp -n "$TPL/.claude/agents/"*.md         "$DEST/.claude/agents/"         2>/dev/null || true
cp -n "$TPL/.claude/commands/"*.md       "$DEST/.claude/commands/"       2>/dev/null || true
cp -n "$TPL/docs/lessons.md"             "$DEST/docs/lessons.md"         2>/dev/null || true
cp -n "$TPL/docs/specs/_TEMPLATE.md"     "$DEST/docs/specs/"             2>/dev/null || true
cp -n "$TPL/docs/specs/README.md"        "$DEST/docs/specs/"            2>/dev/null || true
cp -n "$TPL/tools/board.mjs"             "$DEST/tools/board.mjs"         2>/dev/null || true
cp -n "$TPL/docs/.gitignore"             "$DEST/docs/.gitignore"         2>/dev/null || true
cp -n "$TPL/.claude/.gitignore"          "$DEST/.claude/.gitignore"      2>/dev/null || true

echo "▶ 填入项目名/id（CLAUDE.md 占位符 {{PROJECT_NAME}}/{{PROJECT_ID}}）"
NP_NAME="$NAME" NP_ID="$ID" node -e '
const fs=require("fs"); const f=process.argv[1];
if(fs.existsSync(f)){let s=fs.readFileSync(f,"utf8");s=s.split("{{PROJECT_NAME}}").join(process.env.NP_NAME).split("{{PROJECT_ID}}").join(process.env.NP_ID);fs.writeFileSync(f,s);}
' "$DEST/CLAUDE.md"

echo "▶ 初始化空状态文件"
[ -f "$DEST/docs/tasks.json" ]          || echo '{"title":"开发清单","groups":[]}'      > "$DEST/docs/tasks.json"
[ -f "$DEST/docs/board.json" ]          || echo '{"specs":[],"summary":{"total":0,"accepted":0,"inDev":0,"ready":0,"draft":0},"nodes":["product","backend","frontend","test","ci","review","accept"]}' > "$DEST/docs/board.json"
[ -f "$DEST/docs/.state/agents.json" ]  || echo '{"updatedAt":"","agents":[{"id":"dev","name":"开发","icon":"code","status":"idle","current":"","since":""}]}' > "$DEST/docs/.state/agents.json"

echo "▶ 注册到用户数据目录（~/.steward/projects.json，与工具本体隔离）"
NP_ID="$ID" NP_NAME="$NAME" NP_DEST="$DEST" node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const dir=process.env.STEWARD_DATA||path.join(os.homedir(),".steward"); fs.mkdirSync(dir,{recursive:true});
const f=path.join(dir,"projects.json");
let j={projects:[]}; try{ j=JSON.parse(fs.readFileSync(f,"utf8")); }catch{} if(!j.projects)j.projects=[];
if(!j.projects.find(p=>p.id===process.env.NP_ID)) j.projects.push({id:process.env.NP_ID,name:process.env.NP_NAME,path:process.env.NP_DEST});
fs.writeFileSync(f, JSON.stringify(j,null,2));
console.log("  ✓ 已注册:", process.env.NP_ID, "→", process.env.NP_DEST, "（"+f+"）");
'

echo ""
echo "✓ 完成。重启服务后控制台下拉即出现 [$NAME]："
echo "    bash tools/start.sh"
echo "下一步（在控制台为该项目开个窗口里执行）："
echo "  • 已有代码库       → /scan ：扫源码自动建 docs/specs 规约基线（草稿），你评审 draft→ready"
echo "  • 全新项目(PRD+原型) → /init ：定栈+搭骨架，再 /spec 拆 spec、/build 开发"
