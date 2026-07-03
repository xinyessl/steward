# steward 支持 Codex CLI —— 设计与实现手册

> 目标:让 steward 除了 claude Code，也能把 **OpenAI Codex CLI**(`codex`)当引擎，做到**完整能力**（跑 + 状态灯 + 历史/恢复 + 编排方法论）。
> 基准：实测 `codex-cli 0.142.5`（`@openai/codex`）+ 官方文档 `developers.openai.com/codex/*`。

## 0. 一句话结论
codex 新版内置 **hooks**（事件名/stdin-JSON 协议与 claude 几乎一致）→ **状态检测事件驱动、不用抓屏**，这是全 parity 最大的利好。命令拼装结构、项目内自带命令、AGENTS.md 是主要差异点。

## 1. claude → codex 能力对照
| 能力 | claude(现状) | codex 对应 | 难度 |
|---|---|---|---|
| 起交互 + 放权 | `claude --dangerously-skip-permissions` | `codex --dangerously-bypass-approvals-and-sandbox`（⚠️ 无 `--full-auto`，已删） | 易 |
| 状态检测 | hooks: UserPromptSubmit/Stop/Notification 写状态文件 | **hooks: UserPromptSubmit/Stop/PermissionRequest**，stdin 收 JSON，同法写文件 | 易 |
| 恢复会话 | `--resume <id>`（顶层 flag） | `codex resume <id>` / `codex resume --last`（**子命令**） | 中 |
| 会话列表+预览 | 扒 `~/.claude/projects/<cwd>/*.jsonl` 第一条 user msg | 读 `~/.codex/session_index.jsonl`（现成 `thread_name` 当标题）+ `sessions/YYYY/MM/DD/rollout-*.jsonl`（`session_meta.cwd` 过滤项目） | 易(更省) |
| 自定义斜杠命令 | 项目内 `.claude/commands/*.md`(随 repo) | `~/.codex/prompts/*.md`(**仅用户级、已 deprecated**)；随 repo 用 **Skills `.codex/skills/*/SKILL.md`** | **难/机制不同** |
| 项目指令文件 | 项目根 `CLAUDE.md` | `AGENTS.md`（默认不读 CLAUDE.md；可 `project_doc_fallback_filenames=["CLAUDE.md"]` 兜底） | 中 |
| 无头调用 | headless claude | `codex exec "<prompt>"`（`--json` / `-o FILE` / `--output-schema`，比 claude 更强；⚠️ exec 不认 `-a`） | 易 |
| 子代理并行 | Agent/Task | codex subagents（TOML 定义，≤8 并行，`agents.max_depth`） | 中 |

## 2. codex 关键事实(实测)
- **启动放权**：`codex --dangerously-bypass-approvals-and-sandbox`（或 `-a on-request -s workspace-write`）。`--full-auto` 已删。
- **会话恢复是子命令**：`codex resume <uuid|name>` / `--last` / `--all`（默认只列当前 cwd）。非交互：`codex exec resume <id> "prompt"`。
- **会话存储**：`~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`；首行 `type:session_meta`（含 `id`/`cwd`/`cli_version`）。索引 `~/.codex/session_index.jsonl` 每行 `{id, thread_name, updated_at}` → 直接当列表+预览。
- **hooks**：位置 `~/.codex/hooks.json`(用户级) / `<repo>/.codex/hooks.json`(项目级) / config.toml `[hooks]`。格式 `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"prog --state idle"}]}]}}`。stdin 收 JSON：`session_id`/`cwd`/`hook_event_name`/`model`/`permission_mode`/`transcript_path`，turn 级带 `turn_id`，UserPromptSubmit 带 `prompt`。
  - 状态映射：`UserPromptSubmit`→doing、`Stop`→idle、`PermissionRequest`→waiting(待确认)。
  - **⚠️ hook 信任门槛**：非托管 command hook 首次要在 TUI `/hooks` 信任，否则静默不触发；无头/后台起 codex **必须 `--dangerously-bypass-hook-trust`**。
- **自定义命令**：`~/.codex/prompts/*.md`(用户级、deprecated)；**随 repo 走用 Skills `<repo>/.codex/skills/*/SKILL.md`**(frontmatter `name`/`description`，可被模型隐式调用)。
- **项目指令**：读 `AGENTS.md`（从 git root 向 cwd 逐级拼接，越近越覆盖）。让它读 CLAUDE.md：config `project_doc_fallback_filenames=["CLAUDE.md"]`（仅 AGENTS.md 缺失时生效）。
- **无头**：`codex exec "<prompt>"` + `--json`/`-o FILE`/`--output-schema`/`--skip-git-repo-check`。
- **安装脆弱**：npm 平台二进制可能缺失→静默 ENOENT。steward 探测要校验**真身可执行**(跑 `codex --version`)，不能只 `which codex`。

## 3. 架构:CLI 引擎适配器(ENGINES)
把"引擎相关"的东西收敛成一张表 + 一组函数，main.js / server.mjs 不再硬编码 claude：

```
engine = {
  id: 'claude' | 'codex',
  bin: 探测到的可执行路径,
  buildArgs({sessionId, hookSettingsPath}) → string[]   // 起交互(含放权+resume+hooks注入)
  hookConfig(scriptPath) → 写给 --settings/hooks.json 的对象 + 注入方式
  stateFromHook(json) → 'doing'|'idle'|'waiting'          // 事件名→状态(claude:Notification / codex:PermissionRequest)
  listSessions(cwd) → [{id, mtime, preview}]              // claude:jsonl扒 / codex:session_index.jsonl
  resumeArgs(id) → string[]                               // claude:['--resume',id] / codex:['resume',id]
  execCmd(prompt) → string[]                              // 无头:claude headless / codex exec
  commandsHome() → 命令/Skills 落点
}
```
- **引擎选择**：新窗口时选 claude/codex；项目可设默认引擎(存 projects.json 或本地)。窗口记 `engine`。
- 状态钩子文件 `~/.steward/cli-state/<key>.json` 复用；hook 脚本对两家通用(都 stdin 读 session_id + 写文件)，仅事件→状态映射按引擎。

## 4. 分阶段落地
- **P0 地基**：抽 ENGINES 适配器；把现有 claude 逻辑改成走 `engine.*`（claude 行为不变，回归验证）。
- **P1 codex 跑 + 状态 + 历史**（桌面优先）：探测 codex(校验真身)；`buildArgs` 起 codex(bypass approvals + `--dangerously-bypass-hook-trust` + `.codex/hooks.json` 注入 + resume 子命令)；`stateFromHook`(PermissionRequest→waiting)；`listSessions` 读 session_index.jsonl；新窗口选引擎 UI。
- **P2 编排 parity**：把 `.claude/commands/*` 的 /intake /build /spec 等**移植成 codex Skills**(`templates/.codex/skills/`，随受管项目下发)；给受管项目补 `AGENTS.md`(指向/复制 CLAUDE.md)或配 fallback；server 无头调用改走 `codex exec`；dev 子代理评估 TOML subagents。
- **P3 web/tmux + 打磨**：web 版(tmux)也支持 codex；安装自检加 codex 真身校验；文档。

## 5. 移植难点(codex 缺失/差异大)
1. 项目内自带命令：codex custom prompts 仅用户级+deprecated → 改用 **Skills(.codex/skills, 随 repo)**，是最大结构改造。
2. hook 信任门槛：无头必须 `--dangerously-bypass-hook-trust`。
3. 待确认事件名 `PermissionRequest`(非 Notification)。
4. 恢复是子命令、exec 不认 `-a`、`--full-auto` 已删 → 命令拼装按 codex 子命令结构重写。
5. 项目指令要补 AGENTS.md。
6. 安装脆弱 → 探测校验真身。

## 6.5 交互设计(引擎选择)
现状:CLI 全局硬编码 claude(`CLAUDE_BIN`/`CLAUDE_EXTRA`、`openWindow` 写死 `claude --resume`、状态抓屏匹配 claude spinner、历史读 `~/.claude/projects`、命令读 `.claude/commands`、文案"每个窗口=一段 claude 对话")。

**定稿方向(引擎粒度 = 窗口级 + 项目默认兜底)**:
- steward 模型本就是「每个窗口 = 一段独立对话 = 一个独立 CLI 进程」(`openWindows` Map)→ **引擎跟窗口走**。同一项目可同时开 claude 窗口 + codex 窗口(便于对比)。已开窗口不受影响。
- **开新窗口入口**:「新对话」旁并排两个小图标(claude / codex),点哪个开哪个引擎;或分裂下拉按钮。默认引擎走主按钮。
- **tab 引擎角标**:每个 tab 加引擎徽章(复用 `srcMeta` 的徽章配色体系),一眼看出谁在跑。
- **历史对话按引擎分**:浮层顶部 claude / codex 切换(各读各的存储);`openSession` 按引擎决定 `claude --resume <id>` 还是 `codex resume <id>`。
- **健康检查**:`/api/health` 加 codex 探测——**必须真跑 `codex --version`**(实测二进制可能静默 ENOENT),没装/装坏就把 codex 选项灰掉 + tooltip。
- **默认引擎**:全局默认 claude;项目可存 `defaultEngine` 覆盖(B+C 叠加)。
- **可扩展**:代码按 `ENGINES` 注册表写(以后可加 gemini-cli 等),UI 先只露 claude/codex。
- **信任坑藏后端**:起 codex 自动加 `--dangerously-bypass-hook-trust`,不打扰用户。

## 6.6 待补实测(集成时用能联网登录的 codex 账号跑一遍完整 turn)
`PermissionRequest`/`PostToolUse`/`Stop` 的完整 stdin 字段(本次因 auth 过期只实抓到 SessionStart/UserPromptSubmit)；以 `codex-rs/hooks/schema/generated/` 的 draft-07 schema 为准。
