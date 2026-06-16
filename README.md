# Steward · 多项目研发中枢

> 一个像 VSCode 一样的**空白工具**：拿到就用，导入你自己的项目开发。核心理念——**spec 驱动**：每个项目都以统一格式的规约 `docs/specs/<ID>.md` 为事实源，让不同人/AI 参与同一项目时照着 spec 走、不踩坑。

零三方依赖（一个 Node 脚本起服务），单页控制台，多项目一处纳管、一处看。

---

## 它解决什么

- **多项目一处管**：所有项目（前端/后端/任意栈）注册进来，一个控制台切换、看进度、派活。
- **导入存量项目自动建规约**：`/scan` 逆向扫描现有代码，按**功能模块**生成 `docs/specs/*.md` 基线（便宜模型、增量、标 `NEEDS-HUMAN`），让老项目也"有据可查"。
- **spec 驱动开发**：新需求/改动先拆条 + **影响面分析**（改一处自动算波及哪些 spec）→ 改 spec → 实现 → 看板验收。
- **内嵌终端**：每个项目可开多个 claude 对话窗口（ttyd + tmux 持久化，刷新/重连不丢），三色状态实时显示在干活/待确认/空闲。
- **工具与数据隔离**：工具本体不含任何项目数据；项目注册表在 `~/.steward/`，各项目产物在各自目录——更新工具不碰你的数据。

## 功能一览

- 左侧：按**功能模块分组**的任务清单（进度灯 + 优先级 + 状态），**待验收可一键「通过/打回」**，点条目看 spec 全文。
- 右侧：内嵌终端多窗口（含「命令」面板、历史对话、可拖拽分隔）。
- 顶部：项目切换（下拉 / 全部铺开）、🔔 待办通知（点击定位高亮、可忽略）。

---

## 安装

依赖：**Node.js**（跑控制台）、**ttyd + tmux**（内嵌终端 + 会话持久化）。

```bash
# macOS
brew install ttyd tmux
# Linux 按发行版装 ttyd、tmux 即可
```

## 启动

```bash
git clone https://github.com/xinyessl/steward.git
cd steward
bash tools/start.sh          # → http://127.0.0.1:5178
```

## 快速上手

1. 控制台点 **「新增项目」**，填 id / 名称 / 路径（指向已有代码库 = 导入，只补团队文件不动你的代码；不存在 = 新建）。
2. 给项目开一个**终端窗口**，跑 `/scan` —— 扫源码、按功能模块生成 `docs/specs/*.md` 规约基线（草稿，待你评审）。
3. 之后新需求/改动用 `/spec`·`/build`·`/fix`：先拆条 + 影响面分析 → 改 spec → 实现 → 在看板「通过验收 / 打回」。

## 斜杠命令（每个项目自带）

| 命令 | 作用 |
|---|---|
| `/scan [模块]` | 扫现有代码，按功能模块逆向生成/更新 spec 基线 |
| `/spec <需求>` | 把需求（可一次多条）转成可验证 spec，先拆条 + 影响面分析 |
| `/build <id>` | 按 spec 实现一个功能（开发 agent：实现 + 测试 + 真库冒烟） |
| `/fix <缺陷/需求>` | 缺陷/改动闭环（拆条 + 影响面 → 改 spec/测试 → 改码 → 回归） |
| `/accept <id>` | 验收闭环（出验收材料 + spec diff 确认；打回则自动驱动修复） |
| `/autopilot [范围]` | 自动驾驶：跨模块并行，把功能逐条做到待验收 |

---

## 架构与目录

```
steward/                     # 工具本体（可分享，不含项目数据）
├─ tools/server.mjs          #   控制台服务（零依赖）
├─ tools/start.sh            #   启动
├─ tools/new-project.sh      #   命令行纳管项目
├─ tools/export.sh           #   导出干净分享包
├─ dashboard/index.html      #   控制台 UI
└─ templates/                #   新项目脚手架（整套复制进新项目）
   ├─ CLAUDE.md              #     被管项目的编排手册（方法论主体）
   ├─ .claude/agents/dev.md  #     开发 agent
   ├─ .claude/commands/      #     /scan /spec /build /fix /accept /autopilot
   ├─ docs/specs/_TEMPLATE.md#     统一 spec 模板
   └─ tools/board.mjs        #     从 spec 派生看板

~/.steward/projects.json     # 用户数据：项目注册表（与工具隔离，可用 STEWARD_DATA 覆盖）
<你的项目>/docs/specs/*.md    # 各项目产物：规约（事实源，提交 git）
<你的项目>/docs/board.json    # 由 board.mjs 自动派生（不提交，gitignore）
```

### 该提交什么（项目侧）
- **提交**：`docs/specs/*`（源头，含 status）、`docs/changes`、`docs/reviews`、`CLAUDE.md`、`.claude/agents`+`commands`、`tools/board.mjs`。
- **不提交**（自动生成 / 运行态 / 本地）：`docs/board.json`、`docs/board.md`、`docs/tasks.json`、`docs/.state/`、`.claude/plan.md`、`.claude/settings.local.json`。
  > 新导入的项目会自带 `docs/.gitignore` / `.claude/.gitignore`，自动处理好这条边界。

## 方法论 TL;DR

- **唯一事实源 = `docs/specs/*`**；无 spec 不开发，代码/测试/提交回链 spec。
- **spec-first**：需求/缺陷先改 spec 再改码。
- **功能模块组织**：spec 按功能模块（产品面）分组，每条 = 一个全栈功能。
- **影响面分析**：动手前先拆条 + 顺依赖/共享表/共享接口算波及面，给人确认。
- **人只守关卡**：spec 评审、验收、放行、模糊点裁决；其余文档驱动、自动流转。

详见 `templates/CLAUDE.md`（每个被管项目自带的编排手册）。

---

## 导出分享包

```bash
bash tools/export.sh         # → ~/Desktop/steward-export/steward-export.tgz（干净、不含任何项目数据）
```

## License

[MIT](LICENSE) © xinyessl
