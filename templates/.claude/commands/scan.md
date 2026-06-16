---
description: 扫描本项目源码，按模块生成/更新 docs/specs/<ID>.md 规约草稿（导入存量项目用·便宜模型·按模块·增量）
---
你是本项目编排器。把现有代码逆向抽取成**统一格式的 spec**，让项目"资料可查、不同人参与不踩坑"。范围：「$ARGUMENTS」（功能模块名/`全部`；留空则先**和人确认顶层功能模块清单**再扫，**默认只扫核心，禁止一上来全扫烧 token**）。

## 原则（核心：两层结构——模块分组，模块内拆多条功能 spec）
- **两层，别压成一层**：
  - **`module`（功能模块）= 分组类别**，是少数几个产品面/能力域（和人确认，别按 `xxx-server`/`xxx-web` 代码目录硬分）。**module 本身不是一条 spec**。
  - **每条 spec = 该模块里的一个具体功能/页面/能力**，一个 module 下**通常有多条 spec**。
  - 例：模块「后端管理端」下拆出 工作台、租户管理、用户管理、系统配置、模型配置、运营监控… 各一条；模块「用户开票端」下拆出 开票、台账、补贴、AI对话、登录… 各一条。**绝不能把整个模块写成一条 spec**。
- **每条 spec 全栈一条**：含该功能的前端 + 后端 + 数据，**不要拆成独立的"前端 spec / 后端 spec"**。
- **功能粒度**：按代码里的页面/路由/菜单/能力来切，一个用户能感知的功能 ≈ 一条 spec。
- **逆向抽取的是"现状"，以代码为准**：只写代码能确证的（职责/接口/数据/流程）。**项目里的 PRD/设计文档可能已过时——仅作参考、不作依据，与代码冲突时以代码为准**；说不清的标 `NEEDS-HUMAN`，绝不臆造。
- **status 按现状定**：扫描的是已上线代码 → 标 **`status: accepted`（as-built 基线，后续只维护）**；确实半成品才 `draft`。
- **统一格式**：每条 `docs/specs/<ID>.md` 按 `docs/specs/_TEMPLATE.md` 结构，`module:` 填**顶层功能模块名**，id 用本项目统一前缀。
- **成本可控**：扫描子代理用**便宜模型**（`Agent(..., model:'haiku'|'sonnet')`）；按模块、可并行跨模块。

## 流程
1. **定顶层功能模块**：通读项目结构 + 入口/路由，归纳出**几个**功能模块（产品面），**列给人确认**（不依赖可能过时的 PRD）。
2. **每个功能拆一条全栈 spec**，逐个派扫描子代理（便宜模型）产出 `docs/specs/<ID>.md`：
   - 读相关代码：该功能涉及的前端页面/接口/服务/数据访问，串成一条全栈描述。
   - 按模板填：①模块信息（`module:` = 顶层功能模块）②范围 ③**AC（从现有行为反推，Given-When-Then）** ④接口契约（真实路径/入参/出参）⑤数据契约（真实表/字段，禁止臆造列名）⑥业务规则/权限/留痕 ⑦关键流程。拿不准的标 `NEEDS-HUMAN`。
3. 跑 `node tools/board.mjs` 入库。
4. **确保 .gitignore 到位（只提交源头、不提交派生）**：若本项目是 git 仓库——
   - `docs/.gitignore` 含：`board.json` `board.md` `tasks.json` `.state/`；`.claude/.gitignore` 含：`settings.local.json` `plan.md`（没有就照此创建）。
   - 若 `board.json`/`board.md`/`tasks.json`/`docs/.state`/`.claude/plan.md` 已被误跟踪 → `git rm -r --cached <它们>`（**只取消跟踪、不删文件**），交人确认后提交。
   - 原则：**提交 `docs/specs/*`（+ changes/reviews、CLAUDE.md、.claude/agents+commands、tools/board.mjs）；不提交 board/state/tasks/plan/本地设置**——它们都由 `node tools/board.mjs` 等派生。

## 产出
- 一句话清单：顶层功能模块 + 各模块下的 spec + 各自 `NEEDS-HUMAN` 条数；
- 提醒人：内容以代码为准、PRD 仅参考；`NEEDS-HUMAN` 处待人确认。

> 扫描只建"as-built 基线"。之后的新需求/改动走 `/spec`、`/build`、`/fix`，并按「spec 同步纪律」保持更新（CLAUDE.md §4.5）。
