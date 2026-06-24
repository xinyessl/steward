# Steward 安装指南（给 AI 执行）

> 你是一个能跑 shell 的 AI 助手。请按本文把 **Steward 多项目研发控制台**装到当前机器并启动。
> Steward 是**零三方依赖**的工具（一个 Node 脚本起服务 + 单页前端），不需要 `npm install`。
> 全程在类 Unix 环境（macOS / Linux / WSL2）。**Windows 原生不支持**（无 tmux/ttyd），必须走 WSL2。

---

## 0. 目标与「装好」的判定标准
- 启动后 `http://127.0.0.1:5178` 能打开控制台。
- `curl -s http://127.0.0.1:5178/api/health` 返回 JSON，其中 `node` 有值、`ttyd:true`（`tmux` 可为 false，可选）。
- 满足以上即视为安装成功。

---

## 1. 准备代码（二选一）

**A. 用 git（有网络，推荐，便于 `git pull` 拿更新）**
```bash
git clone https://github.com/xinyessl/steward.git
cd steward
```

**B. 用安装包（内网 / 无 git）**
```bash
tar xzf steward-*.tar.gz      # 解出 steward/ 目录
cd steward
```

---

## 2. 装依赖（必需 + 可选）

先检测，缺啥装啥：
```bash
command -v node  || echo "缺 Node.js（必需）"
command -v claude|| echo "缺 claude CLI（必需，按 Anthropic 官方说明安装）"
command -v ttyd  || echo "缺 ttyd（内嵌终端必需）"
command -v tmux  || echo "缺 tmux（可选：刷新回放/状态灯/滚动复制；缺了控制台仍可用）"
```

按平台安装缺失项：
```bash
# macOS（Homebrew）
brew install node ttyd tmux

# Debian/Ubuntu / WSL2
sudo apt update && sudo apt install -y nodejs npm ttyd tmux
#   ttyd 若 apt 装不到：到 https://github.com/tsl0922/ttyd/releases 下静态二进制放进 /usr/local/bin
#   tmux 装不到也没关系（可选）；apt 下不动先 `sudo apt update`，仍不行换国内镜像源
```
- **Node.js**：必需（跑控制台）。
- **claude CLI**：必需（控制台在项目目录里起 `claude` 对话）；按官方文档装并完成登录。
- **ttyd**：内嵌终端必需。
- **tmux**：可选——缺了控制台照常跑，只少「刷新页面回放终端整屏 / 窗口忙闲状态灯 / 拖拽滚动复制」。

> Windows：先 `wsl --install -d Ubuntu`，**在 Ubuntu 终端里**执行上面的 apt 安装；仓库 clone 在 WSL 的 Linux 文件系统（如 `~/steward`），别放 `/mnt/c/...`。

---

## 3. 启动
```bash
bash tools/start.sh          # 前台运行，Ctrl+C 停止 → http://127.0.0.1:5178
```
脚本会自检 ttyd/tmux 并打印就绪情况，然后起服务在 5178 端口。

如需后台常驻：
```bash
nohup node tools/server.mjs > ~/.steward/server.log 2>&1 &
```

---

## 4. 验证（务必做）
```bash
# 等 1~2 秒后：
curl -s http://127.0.0.1:5178/api/health
# 期望类似：{"claude":{...},"ttyd":true,"tmux":true,"node":"v22.x","projects":0}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5178/   # 期望 200
```
浏览器打开 `http://127.0.0.1:5178`。首次 `projects:0` 是正常的（空工具，还没纳管项目）。

---

## 5. 装好之后（交给用户做，或按用户指示）
- 在控制台点 **「新增项目」** 纳管已有项目（老项目）或新建（绿地 PRD+原型），也支持填 Git 地址 clone。
- 命令行纳管：`bash tools/new-project.sh <id> <名称> <项目绝对路径>`。
- 数据位置：注册表与配置在 **`~/.steward/`**（`projects.json` 等），与工具目录隔离，本机独有。

---

## 6. 排障
- **打不开 / 端口被占**：`lsof -nP -iTCP:5178 -sTCP:LISTEN` 看占用；换端口 `PORT=5179 bash tools/start.sh`。
- **就绪条显示 ✗ ttyd**：没装 ttyd，内嵌终端不可用（其余正常）；按 §2 装。
- **✗ claude 未登录**：在任一终端跑一次 `claude` 完成登录。
- **tmux 显示 ✗**：可选项，不影响使用；想要增强按 §2 装。
- **Windows 原生报错找不到 tmux/ttyd/lsof**：你不在 WSL 里，请改到 WSL2 Ubuntu 终端执行。

---

## 7. 给 AI 的注意事项
- **不要** `npm install`（本工具零三方依赖）。
- **不要**把 `~/.steward/`（注册表、飞书凭据等）提交进任何仓库——那是本机数据。
- 装好别擅自纳管项目或改用户文件；纳管/开发由用户在控制台触发。
- 全部命令在类 Unix shell 执行；Windows 一律走 WSL2。
