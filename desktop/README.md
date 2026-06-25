# Steward 桌面客户端（Electron · macOS / Windows 原生）

把控制台装成桌面 App，**Windows 也原生可用**（终端用 node-pty + xterm.js，不再依赖 ttyd/tmux/WSL）。

## 架构
- **复用** `tools/server.mjs`：Electron 主进程 `fork` 它（electron 当 node 跑），spec/board/todo/feishu/health 等 API **原样可用**。
- **窗口**：加载 `http://127.0.0.1:5180/`（桌面端用 5180，避开 web 版 5178）。
- **终端（唯一重写处）**：`main.js` 用 **node-pty** 跑 `claude`（mac→fork-pty / win→ConPTY，都原生）；`native-term.js` 在渲染端用 **xterm.js** 显示，经 `preload.js` 的 IPC 桥(`window.stewardPty`)收发。**web 版的 ttyd 路径完全不动**——native-term.js 只在 Electron 里注入。
- 忙/待确认/话题：主进程用 `@xterm/headless` 渲染每个 pty 的屏幕，套用与 server 同款启发式，渲染端轮询取。

## 跑起来（在你的 mac，需 GUI）
```bash
cd desktop
npm install          # 装 electron / node-pty / xterm；postinstall 会按 electron 版本重编 node-pty
npm start            # 开发模式启动客户端
```
前置：本机已装 **claude CLI 并登录**（客户端直接调它）。Node 用来 `npm install`。

## 打包安装包（不签名·内部自用）

**一套代码，两种打法:**

### A. 用 GitHub Actions 打（推荐，不用自己有 Windows 机器）
GitHub → **Actions** → 「打包桌面客户端」→ **Run workflow** → 选 `both / mac / win` → 跑完在该次运行的 **Artifacts** 下载 `steward-macos-dmg` / `steward-windows-exe`。
- mac 在 macos runner 打 dmg，win 在 windows runner 打 exe，**node-pty 各自原生重编**，互不影响。
- 配置见 `.github/workflows/desktop.yml`。

### B. 本地打（只能打当前系统的）
```bash
npm run dist:mac     # 在 mac 上 → dist/*.dmg
npm run dist:win     # 在 Windows 上 → dist/*.exe
```

未签名：首次打开 mac 右键「打开」、Windows 点「仍要运行」。要对外分发再补签名（Apple 开发者号 + Windows 证书）。

## 当前状态（v0.1·首版，需首次运行联调）
> ⚠️ 作者无 GUI 环境跑不了 Electron，**以下终端集成是首次实现、未在真机验证**，第一次 `npm start` 大概率要小修。已知要重点核的点：
- **node-pty 重编**：`npm install` 后若报 ABI/版本不符，跑 `npx electron-rebuild -f -w node-pty` 或 `npx electron-builder install-app-deps`。
- **渲染端能否读到 dashboard 的 `let` 变量**（`windows/PROJECT/activeIdx/winState/termBuiltFor` 等）：native-term.js 靠注入脚本与页面**共享全局词法作用域**来读写它们；若控制台报这些未定义，需把它们在 `dashboard/index.html` 暴露到 `window.` 上（或把 native 分支并进 dashboard）。
- **xterm UMD 全局名**：依赖 `window.Terminal` / `window.FitAddon`；若注入后 `XTerm` 为空，调整 `main.js` 里 `require.resolve` 的 xterm 文件路径。
- **旧轮询**：dashboard 的 `setInterval(pollWinStates,2500)` 捕获了旧引用；native 另起 1.5s 轮询覆盖，状态灯应以 native 为准（若闪烁，把 dashboard 那处 interval 改成 `()=>pollWinStates()`）。

## 文件
- `main.js`：主进程（fork server + 窗口 + node-pty + 状态检测 + 注入）
- `preload.js`：`window.stewardPty` 安全桥
- `native-term.js`：渲染端 xterm + 覆盖终端函数（仅 Electron 注入）
- `package.json`：依赖 + electron-builder 配置（dmg / nsis，不签名）
