# tools · 进度与控制台

## 启动控制台（推荐入口）
```bash
node tools/server.mjs          # 默认 http://127.0.0.1:51780
# 可选：PORT=6001 node tools/server.mjs
```
打开浏览器即可：左侧实时进度看板，右侧直接对话调起编排器（在仓库内跑 `claude`）。

### 让对话能自动改文件/跑 agent（本地可信环境）
对话默认 `claude -p`，遇到需要写文件/执行的操作会受权限限制。可通过环境变量放开：
```bash
CLAUDE_ARGS="-p --output-format text --dangerously-skip-permissions" node tools/server.mjs
```
> 仅在本地可信环境使用；它允许编排器自动改文件、跑构建/agent。

## 只生成进度（不开服务）
```bash
node tools/board.mjs           # 派生 docs/board.json + docs/board.md
```
状态来源：
- 每条 spec 头部 `status`（draft/ready/in-dev/testing/accepted）→ 产品/验收节点
- `docs/.state/<spec-id>.json` → 后端/前端/测试/CI/评审节点，形如：
  ```json
  { "nodes": { "backend": "pass", "frontend": "doing", "test": "todo", "ci": "todo", "review": "todo" } }
  ```
  值：`todo / doing / pass / fail / wait`

> board.md 由脚本生成，请勿手改。编排器在流水线每个节点完成后写 `.state` 并重跑本脚本。

## 前置
- 已安装并登录 Claude Code CLI（`claude`）—— 控制台对话依赖它。
- Node 18+。
