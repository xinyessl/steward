# Steward · 多项目研发中枢

[English](README.md) | **简体中文**

> 一个像 VSCode 一样的**空白工具**：拿到就用，导入你自己的项目开发。核心理念——**spec 驱动**：每个项目都以统一格式的规约 `docs/specs/<ID>.md` 为事实源，让不同人/AI 参与同一项目时照着 spec 走、不踩坑。

零三方依赖（一个 Node 脚本起服务），单页控制台，多项目一处纳管、一处看。

---

## 它解决什么

- **多项目一处管**：所有项目（前端/后端/任意栈）注册进来，一个控制台切换、看进度、派活。
- **导入存量项目自动建规约**：`/scan` 逆向扫描现有代码，按**功能模块**生成 `docs/specs/*.md` 基线（便宜模型、增量、标 `NEEDS-HUMAN`），让老项目也"有据可查"。
- **spec 驱动开发**：新需求/改动先拆条 + **影响面分析**（改一处自动算波及哪些 spec）→ 改 spec → 实现 → 看板验收。
- **解决过的问题，别再犯第二次**——**两层经验库**：每个非显然坑都沉淀成一条教训、按范围分流。**项目专属**（特定样式、主题色、本项目字段怪癖）进该项目的 `docs/lessons.md`；**通用**（分页是否生效、搜索/筛选交互是否统一…）进 Steward 的**全局** `lessons.md`（随工具提交、跨所有项目和使用者共享）。开发 agent **每次开工前两层都读、收尾后回写**——坑不再复发，本项目内不再犯，所有用 steward 的人也不再犯。这是本系统很关键的一块价值。
- **内嵌终端（Claude / Codex / 命令行）**：每个项目可开多个窗口——用 **Claude** 或 **Codex** 起 AI 对话、或开**纯命令行**自己敲命令；ttyd + tmux 持久化（刷新/重连/强杀不丢会话），三色状态实时显示在干活/待确认/空闲。
- **桌面客户端（原生 mac / Windows）**：可把控制台装成桌面 App，终端改用 node-pty + xterm（原生），**Windows 也免 WSL 原生可用**；内置「检查更新」热更代码、不用重装。见下方「桌面客户端」。
- **工具与数据隔离**：工具本体不含任何项目数据；项目注册表在 `~/.steward/`，各项目产物在各自目录——更新工具不碰你的数据。

## 功能一览

- 左侧：按**功能模块分组**的任务清单（进度灯 + 优先级 + 状态），**待验收可一键「通过/打回」**，点条目看 spec 全文。
- 右侧：内嵌终端多窗口（含「命令」面板、历史对话、可拖拽分隔）。
- 顶部：项目切换（下拉 / 全部铺开）、🔔 待办通知（点击定位高亮、可忽略）。

---

## 安装

> 想让 **AI 帮你自动装**？把 [`docs/INSTALL-for-AI.md`](docs/INSTALL-for-AI.md) 丢给它照做即可（含检测/安装/启动/验证/排障全流程）。

依赖：**Node.js**（跑控制台）、**ttyd + tmux**（内嵌终端 + 会话持久化）、**claude CLI**。

```bash
# macOS
brew install ttyd tmux

# Linux (Debian/Ubuntu)
sudo apt update
sudo apt install -y tmux
sudo apt install -y ttyd      # Ubuntu 22.04+ 自带；旧版没有就从 ttyd releases 下静态二进制
```

### Windows

> **想在 Windows 原生用、免 WSL？** 直接用下方「**桌面客户端**」——终端走 node-pty + xterm，不依赖 ttyd/tmux。**下面这套 WSL 方式只针对 web 版控制台。**

**web 版**依赖 `ttyd` / `tmux` / `lsof` / `pkill` 等类 Unix 组件，Windows 原生跑不了（PowerShell/CMD 里没有 tmux 可装——这就是"tmux 下载不了"的常见原因）。要在 Windows 上跑 **web 版**请走 **WSL2**（Windows Subsystem for Linux），在 WSL 里装：

1. 安装 WSL2 + 发行版（管理员 PowerShell）：`wsl --install -d Ubuntu`，重启后进入 Ubuntu。
2. **在 WSL 里**装依赖（注意：是在 Ubuntu 终端里，不是 PowerShell）：
   ```bash
   sudo apt update && sudo apt install -y nodejs npm tmux ttyd
   # claude CLI 也装在 WSL 内（按官方说明）
   ```
3. **把仓库 clone 在 WSL 的 Linux 文件系统里**（如 `~/steward`），**别放在 `/mnt/c/...`**——`fs.watch` 在跨盘挂载点不可靠，看板不会自动刷新。
4. 在 WSL 里 `bash tools/start.sh`，然后用 **Windows 浏览器**打开 http://127.0.0.1:51780（WSL2 自动转发 localhost）。

> **tmux 是可选的**：装不上也能用——控制台照常跑，只是失去「刷新页面后回放终端整屏」「窗口忙/待确认状态灯」「滚动选择复制」这几个增强。所以别被它卡住。
>
> **WSL 里 `apt install tmux` 还是下不动？** 多半是 apt 源/网络问题，按需试：
> ```bash
> sudo apt update                      # 先更新索引，最常见的遗漏
> # 仍失败 → 换国内镜像源(清华/阿里)后再 apt update && apt install -y tmux
> # 实在装不了 tmux → 先跳过它(只装 ttyd 即可启动)，或用静态二进制：
> #   到 https://github.com/tmux/tmux 自行编译，或找 tmux 静态构建放进 PATH
> ```
> `ttyd` 同理：Ubuntu 22.04+ 自带，旧版从 [ttyd releases](https://github.com/tsl0922/ttyd/releases) 下静态二进制丢进 `/usr/local/bin`。

## 启动

```bash
git clone https://github.com/xinyessl/steward.git
cd steward
bash tools/start.sh          # → http://127.0.0.1:51780
```

## 桌面客户端（可选 · Windows 推荐）

把控制台装成桌面 App，**Windows 原生可用、无需 WSL**（终端用 node-pty + xterm，不依赖 ttyd/tmux/lsof）。mac 也更顺手。

- **下载安装**：到 [Releases](https://github.com/xinyessl/steward/releases/latest) 下 `Steward-*.dmg`（mac）/ `Steward.Setup.*.exe`（Windows），装上即用。未签名：首次打开 mac 右键「打开」、Windows 点「仍要运行」。
- **热更**：App 里「检查更新」直接拉最新代码（tools / dashboard / templates），不用重装 dmg；壳本身有变（如终端引擎）才需要装新包。
- **自己跑 / 打包**：`cd desktop && npm install && npm start`；打安装包见 `desktop/README.md`（本地 `npm run dist:mac` / `dist:win`，或推 `v*` tag 走 GitHub Actions 自动打 mac + win 包并发 Release）。

## 快速上手

1. 控制台点 **「新增项目」**，先选**项目类型**：
   - **老项目（已有代码）** → 路径指向现有代码库（只补团队文件、不动你的代码）。
   - **新项目（绿地）** → 路径填一个新目录，并直接选 **PRD 文件** + **原型图目录**，建项目时自动拷进 `docs/PRD.*` 与 `docs/prototype/`。
   - **Git 仓库** → 填克隆地址（https / git@ / ssh），用本机 git 凭证 `git clone` 到本地目录后按已有代码纳管。
2. 给项目开一个**终端窗口**，按起点走（建好后控制台会提示自动跑）：
   - **老项目** → `/scan` 逆向扫源码，按功能模块生成 `docs/specs/*.md` 基线（草稿，待评审）。
   - **绿地** → `/init` 定栈 + 搭最小骨架，再 `/spec` 把 PRD 拆成 spec 树（此时 **PRD+原型 = 事实源**）。
3. 之后新需求/改动用 `/spec`·`/build`·`/fix`：先拆条 + 影响面分析 → 改 spec → 实现 → 在看板「通过验收 / 打回」。

## 斜杠命令（每个项目自带）

| 命令 | 作用 |
|---|---|
| `/init` | 绿地启动：定栈 + 搭最小工程骨架 + .gitignore（PRD+原型起步、首次 `/build` 前先跑） |
| `/scan [模块]` | 扫现有代码，按功能模块逆向生成/更新**三层说明书**（功能模块地图 + 导读 + FAQ 骨架）|
| `/intake <飞书链接/文本>` | 进件：把飞书文档/多维表格或一段文本拆成任务批次、落进任务清单 |
| `/spec <需求>` | 把需求（可一次多条）转成可验证 spec，先拆条 + 影响面分析 |
| `/build <id>` | 按 spec 实现一个功能（开发 agent：实现 + 测试 + 真库冒烟） |
| `/fix <缺陷/需求>` | 缺陷/改动闭环（拆条 + 影响面 → 改 spec/测试 → 改码 → 回归） |
| `/accept <id>` | 验收闭环（出验收材料 + spec diff 确认；打回则自动驱动修复） |
| `/lesson [现象]` | 把刚解决的坑沉淀进经验库，自动分流（项目专属→`docs/lessons.md`；通用→全局共享） |
| `/autopilot [范围]` | 自动驾驶：跨模块并行，把功能逐条做到待验收 |

---

## 架构与目录

```
steward/                     # 工具本体（可分享，不含项目数据）
├─ tools/server.mjs          #   控制台服务（零依赖）
├─ tools/start.sh            #   启动
├─ tools/new-project.sh      #   命令行纳管项目
├─ dashboard/index.html      #   控制台 UI
├─ desktop/                  #   桌面客户端（Electron；node-pty + xterm，原生 mac/Windows）
└─ templates/                #   新项目脚手架（整套复制进新项目）
   ├─ CLAUDE.md              #     被管项目的编排手册（方法论主体）
   ├─ .claude/agents/dev.md  #     开发 agent
   ├─ .claude/commands/      #     /init /scan /spec /build /fix /accept /intake /autopilot …
   ├─ docs/specs/            #     spec 模板：_TEMPLATE(功能)/_TEMPLATE-薄spec/_TEMPLATE-流程 + 00-功能模块地图(层1)
   ├─ docs/faq/              #     层3 FAQ 模板
   └─ tools/board.mjs        #     从 spec 派生看板（识别 type:guide）

~/.steward/projects.json     # 用户数据：项目注册表（与工具隔离，可用 STEWARD_DATA 覆盖）
<你的项目>/docs/specs/*.md    # 各项目产物：规约（事实源，提交 git）
<你的项目>/docs/board.json    # 由 board.mjs 自动派生（不提交，gitignore）
```

### 该提交什么（项目侧）
- **提交**：`docs/specs/*`（源头，含 status）、`docs/lessons.md`（本项目踩坑）、`docs/changes`、`docs/reviews`、`CLAUDE.md`、`.claude/agents`+`commands`、`tools/board.mjs`。（**全局**经验库是 Steward 仓库里的 `lessons.md`，随工具提交。）
- **不提交**（自动生成 / 运行态 / 本地）：`docs/board.json`、`docs/board.md`、`docs/tasks.json`、`docs/.state/`、`.claude/plan.md`、`.claude/settings.local.json`。
  > 新导入的项目会自带 `docs/.gitignore` / `.claude/.gitignore`，自动处理好这条边界。

## 系统说明书（三层 · 给 AI 看的事实源）

存量项目 `/scan` 逆向、或绿地共创，产出一套**给 AI 读的三层说明书**，同时服务「AI 迭代开发」和「现场答疑」两个场景：

- **层1 · 功能模块地图**（`docs/specs/00-功能模块地图.md`）：总纲/最外层口子——全部功能模块清单 + 各模块要点，AI 进来先读它定位任务落在哪。
- **层2 · 导读**（`type: guide`）：只给**核心/复杂场景**的模块深讲机制/库表/数据流；不走 dev/test/accept 流水线，看板里单列「📖 导读」。
- **层3 · FAQ**（`docs/faq/`）：常见问答（症状 → 定位 → 解法），随现场答疑增量沉淀。

功能 spec（用户故事 + AC + 数据契约，挂在总纲下）是**可验收开发单元**；已有导读打底、只做单次改动时，用**薄 spec 模板**（`_TEMPLATE-薄spec.md`：只写 AC + DoD + 数据契约，事实/库表指回导读）。

## 方法论 TL;DR

- **唯一事实源 = `docs/specs/*`**；无 spec 不开发，代码/测试/提交回链 spec。
- **spec-first**：需求/缺陷先改 spec 再改码。
- **功能模块组织**：spec 按功能模块（产品面）分组，每条 = 一个全栈功能。
- **影响面分析**：动手前先拆条 + 顺依赖/共享表/共享接口算波及面，给人确认。
- **人只守关卡**：spec 评审、验收、放行、模糊点裁决；其余文档驱动、自动流转。

详见 `templates/CLAUDE.md`（每个被管项目自带的编排手册）。

---

## License

[MIT](LICENSE) © xinyessl
