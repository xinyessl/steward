# 总管 steward · 中枢运行手册

> 本文件随「在 steward 目录里开的 claude 会话」自动加载。**你在 steward = 总管中枢的管理员**：维护控制台、纳管/注册项目、维护脚手架模板。
> ⚠️ 这里**不放业务代码、不写功能**。某个项目的功能开发发生在**那个项目自己的目录**里——控制台会在那里起 `claude`，加载该项目的 `CLAUDE.md`（编排手册）。本文件 ≠ 那份编排手册。

## steward 是什么
项目总管中枢：把多个项目一处纳管、一处看，一句话派开发下场。只持有「控制台 + 脚手架模板」，业务各留各家。

## 核心理念：spec 驱动，每个项目都有据可查
所有项目纳管进来后，都以**统一格式的规约** `docs/specs/<ID>.md` 为事实源——这样不同人/agent 参与同一项目时照着 spec 走、不踩坑。
- **导入即建 spec**：纳管一个**存量项目**后，在控制台给它开个窗口跑 `/scan` —— 按模块逆向抽取代码、生成 `docs/specs/<ID>.md` **草稿**（便宜模型·按模块·增量，避免一次全扫烧 token）。人评审 `draft→ready` 后即作为事实源。
- **绿地即起骨架**：纳管一个**全新项目**（产品刚出 PRD+原型、还没代码）后，把 PRD 放 `docs/PRD.md`、原型放 `docs/prototype/`，跑 `/init` —— 定技术栈 + 填①本项目信息 + 搭最小工程骨架 + .gitignore；再 `/spec` 把 PRD 正向拆成 spec 树。此时 **PRD+原型 = 事实源**（与 `/scan` 的"代码为准"相反方向）。
- **保持同步**：之后的改动走各项目自己的 `/spec`·`/build`·`/fix`，并按编排手册「§4.5 spec 同步纪律」——开发先分类（逻辑变=改 spec、纯 bug/重构=只记 CHG），涉及 spec 的改动**在验收时附 diff 让人确认**，不每次改动都打扰。
- 这套纪律写在 `templates/CLAUDE.md` + `templates/.claude/commands/`，**每个新纳管的项目自带**；存量项目可把 `templates/.claude/commands/scan.md`（及更新过的 CLAUDE.md/fix/accept）同步过去。

## 目录结构（中枢自身）
- `tools/server.mjs`：控制台（多项目，零依赖）。**受管项目注册表存在用户数据目录 `~/.steward/projects.json`（与工具本体隔离，可用 `STEWARD_DATA` 覆盖）**，`{id,name,path}`；控制台据此读各项目 `docs/board.json`、在各项目目录里起 `claude` 与 `tools/board.mjs`。工具目录本身不含任何项目数据，天然可分享。
- `tools/start.sh` / `tools/new-project.sh`：启动 / 纳管脚本。`dashboard/index.html`：控制台 UI。
- `templates/CLAUDE.md`：被管项目的编排手册（方法论主体）。`README.md`：项目介绍 + 使用说明。

## templates/ —— 脚手架模板（与本文件分开）
新建项目时**整套复制**进去的骨架，是「新项目默认长什么样」：
- `templates/CLAUDE.md`：**给被管项目用的编排手册**（不是本文件）。
- `templates/.claude/agents/`、`templates/.claude/commands/`：开发 agent + 斜杠命令。
- `templates/tools/board.mjs`、`templates/docs/specs/{_TEMPLATE,README}.md`、`templates/docs/.state/agents.json`。
> 想改"以后新建项目的默认形态" → 改 `templates/`，**不影响已存在的项目**。改"中枢自己的行为" → 改本文件 / `tools/`。

## 你在 steward 里能做的事
1. **起控制台**：`bash tools/start.sh` → http://127.0.0.1:5178。
2. **纳管项目**：`bash tools/new-project.sh <id> <名称> <绝对路径>`（从 `templates/` 复制骨架 + 注册），或控制台「新增项目」。
3. **维护模板**：编辑 `templates/*`（影响以后新建的项目）。
4. **维护控制台**：改 `tools/server.mjs` / `dashboard/`。

## 你不在这里做的事
- 不写任何业务功能、不改某项目的 spec/代码 → 去那个项目目录。
- 各项目的编排手册是它自己的 `CLAUDE.md`（源自 `templates/CLAUDE.md`），和本文件不是同一份。

## 当前受管项目
| id | 名称 | 路径 |
|---|---|---|
| _（空：用控制台「新增项目」或 `bash tools/new-project.sh` 纳管）_ |  |  |
