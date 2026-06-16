#!/usr/bin/env node
// Steward · 多项目控制台服务（零依赖）
//   - 提供可视化页面（dashboard/）
//   - GET  /api/projects            项目清单（~/.steward/projects.json，与工具隔离）
//   - GET  /api/board?project=ID    该项目进度看板
//   - GET  /api/tasks?project=ID    该项目开发清单
//   - GET  /api/agents?project=ID   该项目 AI 团队状态
//   - GET  /api/events              SSE：任一项目 docs/ 变更时推送
//   - POST /api/chat?project=ID     在该项目目录内跑 `claude -p` 调起编排器
// 用法：node tools/server.mjs  → 打开 http://127.0.0.1:5178
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // 控制台宿主目录（工具本体）
const PORT = process.env.PORT || 5178;
// 同源/同机访问白名单（#6）：本地单用户控制台只接受来自控制台自身的请求，
// 借此挡住「任意网站跨源调本地 API」与 DNS-rebinding（Host 被改成攻击者域名）。
const SELF_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const SELF_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);
// 用户数据目录（与工具本体隔离，像 VSCode）：项目注册表存这里，工具目录保持干净/可分享。可用 STEWARD_DATA 覆盖。
const DATA_DIR = process.env.STEWARD_DATA || path.join(os.homedir(), '.steward');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_FILE)) {   // 首次运行：从旧位置 tools/projects.json 迁移注册表，否则建空表
    let init = JSON.stringify({ projects: [] }, null, 2);
    try { const legacy = path.join(ROOT, 'tools/projects.json'); if (fs.existsSync(legacy)) { const j = JSON.parse(fs.readFileSync(legacy, 'utf8')); if (j && j.projects && j.projects.length) init = JSON.stringify({ projects: j.projects }, null, 2); } } catch {}
    fs.writeFileSync(PROJECTS_FILE, init);
  }
} catch {}
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  try { const s = (spawnSync('which', ['claude']).stdout || '').toString().trim().split('\n')[0]; if (s && fs.existsSync(s)) return s; } catch {}
  for (const c of [path.join(os.homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(c)) return c;
  return 'claude';
}
const CLAUDE_BIN = findClaude();
// 等端口可连通再回调（最多 ~5s），避免 iframe 抢在 ttyd 起好前去连接
function waitForPort(port, cb, tries = 50) {
  const sock = net.connect(port, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); cb(true); });
  sock.once('error', () => { sock.destroy(); if (tries <= 0) return cb(false); setTimeout(() => waitForPort(port, cb, tries - 1), 100); });
}
// 额外参数（如本地放开权限）：CLAUDE_EXTRA="--dangerously-skip-permissions"
const CLAUDE_EXTRA = (process.env.CLAUDE_EXTRA || '').split(' ').filter(Boolean);
// 起子 claude 前剔除从控制台进程继承来的会话身份变量。否则若控制台是从某个 claude 会话里启动的，
// 子 claude 会被当成"子会话"(CHILD_SESSION) → 不落地成可恢复会话 → 进不了「历史对话」。
function childEnv() {
  const e = { ...process.env };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH']) delete e[k];
  return e;
}
// 内嵌终端：每项目一个 ttyd（按 projects.json 顺序分配端口）
function findTtyd() {
  if (process.env.TTYD_BIN && fs.existsSync(process.env.TTYD_BIN)) return process.env.TTYD_BIN;
  for (const c of ['/opt/homebrew/bin/ttyd', '/usr/local/bin/ttyd']) if (fs.existsSync(c)) return c;
  try { const s = (spawnSync('which', ['ttyd']).stdout || '').toString().trim(); if (s && fs.existsSync(s)) return s; } catch {}
  return null;
}
const TTYD_BIN = findTtyd();
const TTYD_BASE = parseInt(process.env.TTYD_BASE || '7700', 10);

// tmux（可选）：claude 跑在 tmux 持久会话里。tmux 在服务端保留整屏内容，刷新页面/断连后重连
// 会完整回放当前屏幕（dtach 不保存屏幕缓冲，重连只剩空屏，故用 tmux）。专用 -L socket 隔离用户自己的 tmux。
function findTmux() {
  if (process.env.TMUX_BIN && fs.existsSync(process.env.TMUX_BIN)) return process.env.TMUX_BIN;
  for (const c of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) if (fs.existsSync(c)) return c;
  try { const s = (spawnSync('which', ['tmux']).stdout || '').toString().trim(); if (s && fs.existsSync(s)) return s; } catch {}
  return null;
}
const TMUX_BIN = findTmux();
const TMUX_SOCK = 'steward';                                   // -L steward 专用 socket
const TMUX_CONF = path.join(os.tmpdir(), 'steward-tmux.conf');
if (TMUX_BIN) { try { fs.writeFileSync(TMUX_CONF, [
  'set -g status off',            // 隐藏底部状态栏，嵌入终端更干净
  'set -sg escape-time 0',        // 无 ESC 延迟，TUI 跟手
  'set -g history-limit 50000',   // 滚动历史
  'set -g mouse on',              // 开鼠标：滚轮翻历史（claude 用普通屏，靠 tmux copy-mode 才能滚）；滚到底自动退出查看模式，回到实时可继续打字/选择
  'bind -T copy-mode    q send -X cancel',   // 查看模式按 q 退出
  'bind -T copy-mode-vi q send -X cancel',
  'set -g destroy-unattached off' // 无客户端时会话保留（刷新后还能 reattach）
].join('\n') + '\n'); } catch {} }
// 按需开窗：每个对话窗口 = 一个独立 ttyd（各跑一段 claude），可同项目多开
const openWindows = new Map(); // key -> { key, port, projectId, sessionId, label, proc, tmuxSess }
const WIN_STATE_FILE = path.join(os.tmpdir(), 'steward-windows.json'); // 持久化窗口元数据，供重启后 adopt
function allocPort() { const used = new Set([...openWindows.values()].map(w => w.port)); let p = TTYD_BASE; while (used.has(p)) p++; return p; }
function saveWindows() { try { fs.writeFileSync(WIN_STATE_FILE, JSON.stringify([...openWindows.values()].map(w => ({ port: w.port, projectId: w.projectId, label: w.label, sessionId: w.sessionId, tmuxSess: w.tmuxSess })))); } catch {} }
function portBound(port) { try { return (((spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout) || '').includes('LISTEN')); } catch { return false; } }
function openWindow(proj, sessionId, label) {
  const port = allocPort();
  const claudeArgs = [CLAUDE_BIN, ...CLAUDE_EXTRA];
  if (sessionId) claudeArgs.push('--resume', sessionId);
  // 有 tmux 就包一层：claude 跑在 tmux 会话里；new-session -A = 在则 attach（不重启 claude）、不在则建并跑。
  // 刷新页面后 ttyd 重连 → 同名 -A attach → tmux 回放整屏，claude TUI 原样恢复。
  let cmd = claudeArgs, tmuxSess = '';
  if (TMUX_BIN) {
    tmuxSess = `steward-${port}`;
    cmd = [TMUX_BIN, '-L', TMUX_SOCK, '-f', TMUX_CONF, 'new-session', '-A', '-s', tmuxSess, ...claudeArgs];
  }
  const args = ['-W', '-i', '127.0.0.1', '-p', String(port), ...cmd];
  const proc = spawn(TTYD_BIN, args, { cwd: proj.path, stdio: 'ignore', env: childEnv() });
  proc.on('error', e => console.error('[ttyd spawn]', e?.message || e));   // spawn 失败不可掀翻进程
  const key = String(port);
  openWindows.set(key, { key, port, projectId: proj.id, sessionId: sessionId || '', label: label || '新对话', proc, tmuxSess });
  saveWindows();
  return { key, port };
}
// 关窗 = 用户主动关：杀 ttyd（有句柄直接 kill，adopt 来的无句柄按端口 pkill）+ kill tmux 会话（彻底结束 claude）
function killMux(sess) { if (!sess || !TMUX_BIN) return; try { spawnSync(TMUX_BIN, ['-L', TMUX_SOCK, 'kill-session', '-t', sess]); } catch {} }
function killTtyd(w) { if (w.proc) { try { w.proc.kill(); } catch {} } else { try { spawnSync('pkill', ['-f', `ttyd -W -i 127.0.0.1 -p ${w.port} `]); } catch {} } }
function closeWindow(key) { const w = openWindows.get(key); if (w) { killTtyd(w); killMux(w.tmuxSess); openWindows.delete(key); saveWindows(); } }
// 进程退出：只存档，不杀 ttyd/tmux —— 让会话存活，下次启动 adopt 接回（重启不打断 claude）
process.on('exit', () => saveWindows());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
// 进程级兜底：单个坏请求 / 子进程 spawn 错误只记日志，绝不掀翻整个控制台
process.on('uncaughtException', e => console.error('[uncaught]', e?.stack || e));
process.on('unhandledRejection', e => console.error('[unhandled]', e?.stack || e));
// 启动时接管已存在的 tmux 会话（上次退出/被 kill 遗留的）：tmux/claude 还活着就拉回来管，端口已被 ttyd 占着则直接认领（无缝），否则重起 ttyd 接回（需刷新页面）
function adoptWindows() {
  if (!TMUX_BIN) return;
  let saved = []; try { saved = JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8')) || []; } catch {}
  const meta = {}; for (const w of saved) if (w && w.tmuxSess) meta[w.tmuxSess] = w;
  let live = []; try { live = (((spawnSync(TMUX_BIN, ['-L', TMUX_SOCK, 'ls', '-F', '#{session_name}'], { encoding: 'utf8' }).stdout) || '').split('\n').map(s => s.trim()).filter(s => /^steward-\d+$/.test(s))); } catch {}
  const fallbackPid = (loadProjects()[0] || {}).id;
  for (const sess of live) {
    const port = parseInt(sess.slice('steward-'.length), 10);
    if ([...openWindows.values()].some(w => w.port === port)) continue;
    const m = meta[sess] || {};
    const projectId = m.projectId || fallbackPid;
    let proc = null;
    if (!portBound(port)) {  // ttyd 没了 → 重起一个接回（new-session -A 已存在=attach，claude 不重启）
      const args = ['-W', '-i', '127.0.0.1', '-p', String(port), TMUX_BIN, '-L', TMUX_SOCK, '-f', TMUX_CONF, 'new-session', '-A', '-s', sess];
      try { proc = spawn(TTYD_BIN, args, { cwd: (projById(projectId) || {}).path || ROOT, stdio: 'ignore', env: childEnv() }); proc.on('error', e => console.error('[ttyd adopt]', e?.message || e)); } catch {}
    } // else：ttyd 还在（被 SIGKILL 残留）→ 直接认领，浏览器 iframe 不断连，无缝
    openWindows.set(String(port), { key: String(port), port, projectId, sessionId: m.sessionId || '', label: m.label || '恢复的对话', proc, tmuxSess: sess });
  }
  saveWindows();
}

// —— 窗口忙/闲检测 ——
// 每 ~2.5s 抓 tmux 屏幕，剔掉会自走的状态灯（ccgotchi 宠物/用量条/模式行）后做差分：
// 变了 = claude 正跑一个 turn（spinner 的秒数计时每秒在动）；没变 = 空闲等输入。忙→闲那一刻 = 刚完成，置 done。
// 异步抓取（#7）：execFile 不阻塞事件循环，多窗口可并发，控制台不再随窗口数变卡。
function capturePane(sess, full) { return new Promise(resolve => { try { const a = ['-L', TMUX_SOCK, 'capture-pane', '-t', sess, '-p']; if (full) a.push('-S', '-'); execFile(TMUX_BIN, a, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (e, out) => resolve(out || '')); } catch { resolve(''); } }); }
function titleFromPane(out) {  // 取最早一条用户输入（❯ 后有内容）作为会话话题，拼接换行续行抓全
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^❯\s+(\S.*)$/); if (!m) continue;
    let t = m[1].trim();
    for (let j = i + 1; j < lines.length; j++) {            // 续行：2+ 空格缩进、非边框、非 ⎿ hook 行
      const c = lines[j];
      if (c.includes('⎿') || /^[\s─-]+$/.test(c) || !/^\s{2,}\S/.test(c)) break;
      t += c.trim();
    }
    if (t) return t.slice(0, 160);
  }
  return '';
}
function sigFromPane(out) {  // 剔掉会自走的状态灯/边框，剩下用于差分判忙闲
  return out.split('\n').filter(l => {
    if (l.includes('⠀')) return false;          // ccgotchi 宠物行（braille 空格）
    if (l.includes('⏵⏵')) return false;          // 模式行（bypass permissions…）
    if (/^\s*\d+h\s/.test(l)) return false;     // 用量条 "5h ●●● 37% 3h21m"
    if (/^[\s─-]*$/.test(l)) return false;      // 边框/空行
    return true;
  }).join('\n');
}
function activityFromPane(out) {  // 提取「最新在干啥」：优先最近的子代理运行行，其次当前 spinner 行（与具体 agent 命名无关）
  const raw = out.split('\n');
  // 1) 子代理运行行：◯/◉/○ <agent> <任务> <计时> · ↓ <tokens>（去掉开头 agent 名 + 尾部计时/token）
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i].match(/^\s*[◯○◉]\s+(\S.*)$/);
    if (!m) continue;
    let t = m[1]
      .replace(/\s*[·∙•]\s*[↑↓].*$/, '').replace(/\s+\d+m?\s*\d+s\b.*$/, '').replace(/\s*\((?:ctrl|esc).*$/i, '')
      .replace(/^[A-Za-z][\w-]*[\s:：]+/, '')   // 去开头 agent 名（dev / xxx-dev 等）
      .trim();
    if (t && !/^(main)\b/i.test(t)) return t.slice(0, 46);
  }
  // 2) 当前 spinner gerund 行（✻/✽… <任务>），取 … 或 ( 之前
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i].match(/^\s*[✻✽✶✷✸✹✺✢·]\s+(\S[^…(]*)/);   // 仅真·claude spinner 字符，避免误命中 * 列表/日志行
    if (m) { const t = m[1].trim(); if (t) return t.slice(0, 46); }
  }
  return '';
}
// 空闲时检测是否在等"确认/选择"（需你处理）→ 红；否则普通空闲 → 黄
function confirmFromPane(out) {
  const tail = out.split('\n').slice(-22).join('\n');
  return /\([yY]\/[nN]\)|\[[yY]\/[nN]\]|↑\/↓ to select|Do you want to (proceed|continue)|是否(继续|确认|要)|确认[?？]|\bProceed\?|press \w+ to (confirm|continue)|❯\s*\d+\.\s|^\s*\d+[.:]\s+(Yes|No|是|否)/m.test(tail);
}
async function pollOne(w) {
  if (!w.tmuxSess) return;
  const out = await capturePane(w.tmuxSess);
  if (!out) return;                            // 本轮抓不到，保留旧状态
  const sig = sigFromPane(out);
  if (w.lastSig !== undefined) {
    const busy = sig !== w.lastSig;
    if (w.busy && !busy) { w.done = true; w.doneAt = Date.now(); }   // 忙→闲：完成
    w.busy = busy;
  } else { w.busy = false; }                   // 首轮：未知按闲（done 仅在真·忙→闲时触发，不会误报）
  w.lastSig = sig;
  w.activity = activityFromPane(out);
  w.confirm = !w.busy && confirmFromPane(out);   // 空闲且在等确认/选择 → 红；否则空闲 → 黄
  if (!w.title) {  // 会话话题（一次性）：resume 的读会话文件 preview，新窗口从全量屏幕抓第一句用户输入
    if (w.sessionId) { try { w.title = sessionPreview(path.join(os.homedir(), '.claude', 'projects', encodeCwd((projById(w.projectId) || {}).path || ''), w.sessionId + '.jsonl')); } catch {} }
    if (!w.title) w.title = titleFromPane(await capturePane(w.tmuxSess, true));
  }
}
async function pollWindows() {   // 所有窗口并发抓取，整轮不阻塞事件循环（#7）
  if (!TMUX_BIN) return;
  await Promise.all([...openWindows.values()].map(w => pollOne(w).catch(() => {})));
}
// 自调度而非 setInterval：上一轮没跑完不会重叠堆积
(function pollLoop() { Promise.resolve(pollWindows()).catch(() => {}).finally(() => setTimeout(pollLoop, 2500)); })();

// ---- claude 会话发现（按项目 cwd 编码）----
function encodeCwd(abs) { return abs.replace(/[/.]/g, '-'); }
function sessionPreview(fp) {
  try {
    // 读前 ~1.5MB 但**按完整行**切（含图片的首条消息那行会很大，base64 内嵌；按字节截断会把这行切坏导致 JSON.parse 失败 → 取不到预览）
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(1500000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let head = buf.toString('utf8', 0, n);
    const nl = head.lastIndexOf('\n'); if (nl > 0) head = head.slice(0, nl);   // 丢掉最后不完整的一行
    let imgSeen = false;
    for (const line of head.split('\n')) {
      if (!line.trim()) continue; let j; try { j = JSON.parse(line); } catch { continue; }
      const m = j.message;
      if (j.type === 'user' && m && m.content) {
        const arr = Array.isArray(m.content) ? m.content : null;
        if (arr && arr.some(b => b.type === 'image')) imgSeen = true;
        let t = typeof m.content === 'string' ? m.content : (arr ? ((arr.find(b => b.type === 'text') || {}).text || '') : '');
        t = (t || '').replace(/\[Image[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();   // 去掉 [Image #N] / [Image: …] 占位
        if (t && !t.startsWith('<')) return t.slice(0, 70);
      }
    }
    if (imgSeen) return '[图片]';   // 只有图片、没文字时给个标签，别空着
  } catch {}
  return '';
}
function listClaudeSessions(abs) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(abs));
  const out = [];
  try { for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.jsonl')) continue; const fp = path.join(dir, f); const st = fs.statSync(fp); out.push({ id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, preview: sessionPreview(fp) }); } } catch {}
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---- 新项目脚手架（复制团队文件，已存在不覆盖）----
function copyIfAbsent(src, dst) { try { if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } } catch {} }
function copyMdDir(srcDir, dstDir) { try { fs.mkdirSync(dstDir, { recursive: true }); for (const f of fs.readdirSync(srcDir)) if (f.endsWith('.md')) copyIfAbsent(path.join(srcDir, f), path.join(dstDir, f)); } catch {} }
// 递归拷贝整个目录（绿地导入原型用）；返回拷贝的文件数
function copyDirAll(srcDir, dstDir) { let n = 0; try { fs.mkdirSync(dstDir, { recursive: true }); for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const s = path.join(srcDir, e.name), d = path.join(dstDir, e.name); if (e.isDirectory()) n += copyDirAll(s, d); else { try { fs.copyFileSync(s, d); n++; } catch {} } } } catch {} return n; }
// 模板占位符替换（{{PROJECT_NAME}} / {{PROJECT_ID}} 等）；文件不存在或无占位符则 no-op
function fillPlaceholders(file, map) { try { if (!fs.existsSync(file)) return; let s = fs.readFileSync(file, 'utf8'); for (const [k, v] of Object.entries(map)) s = s.split(k).join(v); fs.writeFileSync(file, s); } catch {} }
function scaffoldProject(dest, name, id) {
  const T = path.join(ROOT, 'templates');   // 脚手架模板源（与中枢自身的 CLAUDE.md 分开）
  ['docs/specs', 'docs/.state', 'tools'].forEach(d => fs.mkdirSync(path.join(dest, d), { recursive: true }));
  copyIfAbsent(path.join(T, 'CLAUDE.md'), path.join(dest, 'CLAUDE.md'));
  fillPlaceholders(path.join(dest, 'CLAUDE.md'), { '{{PROJECT_NAME}}': name || '', '{{PROJECT_ID}}': id || '' });
  copyMdDir(path.join(T, '.claude/agents'), path.join(dest, '.claude/agents'));
  copyMdDir(path.join(T, '.claude/commands'), path.join(dest, '.claude/commands'));
  copyIfAbsent(path.join(T, 'docs/lessons.md'), path.join(dest, 'docs/lessons.md'));   // 经验库/防回归（源头·提交 git）
  copyIfAbsent(path.join(T, 'docs/specs/_TEMPLATE.md'), path.join(dest, 'docs/specs/_TEMPLATE.md'));
  copyIfAbsent(path.join(T, 'docs/specs/README.md'), path.join(dest, 'docs/specs/README.md'));
  copyIfAbsent(path.join(T, 'tools/board.mjs'), path.join(dest, 'tools/board.mjs'));
  copyIfAbsent(path.join(T, 'docs/.gitignore'), path.join(dest, 'docs/.gitignore'));         // 忽略 board/state/tasks 派生文件
  copyIfAbsent(path.join(T, '.claude/.gitignore'), path.join(dest, '.claude/.gitignore'));   // 忽略本地设置/plan
  if (!fs.existsSync(path.join(dest, 'docs/tasks.json'))) fs.writeFileSync(path.join(dest, 'docs/tasks.json'), JSON.stringify({ title: '开发清单', groups: [] }, null, 2));
  if (!fs.existsSync(path.join(dest, 'docs/board.json'))) fs.writeFileSync(path.join(dest, 'docs/board.json'), JSON.stringify({ specs: [], summary: { total: 0, accepted: 0, inDev: 0, ready: 0, draft: 0 }, nodes: ['product', 'backend', 'frontend', 'test', 'ci', 'review', 'accept'] }, null, 2));
  fs.mkdirSync(path.join(dest, 'docs/.state'), { recursive: true });
  if (!fs.existsSync(path.join(dest, 'docs/.state/agents.json'))) fs.writeFileSync(path.join(dest, 'docs/.state/agents.json'), JSON.stringify({ updatedAt: '', agents: [{ id: 'dev', name: '开发', icon: 'code', status: 'idle', current: '', since: '' }] }, null, 2));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const sseClients = new Set();
function sseBroadcast(obj) { const s = 'data: ' + JSON.stringify(obj) + '\n\n'; for (const c of sseClients) { try { c.write(s); } catch {} } }

function loadProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).projects || []; }
  catch { return []; }   // 空工具：还没纳管任何项目
}
function projById(id) { const ps = loadProjects(); return ps.find(p => p.id === id) || ps[0]; }
function genBoard(projPath) { const bm = path.join(projPath, 'tools/board.mjs'); if (fs.existsSync(bm)) { try { spawnSync('node', [bm], { cwd: projPath }); } catch {} } }   // 同步：避免与连接 body 读取并发 spawn 的 fd 竞态
function send(res, code, body, type = 'application/json') { res.writeHead(code, { 'Content-Type': type }); res.end(body); }
function readOr(file, fallback) { try { return fs.readFileSync(file); } catch { return fallback; } }
function chatFile(p) { return path.join(p.path, 'docs/.state/chat.json'); }
function readChat(p) { try { return JSON.parse(fs.readFileSync(chatFile(p), 'utf8')); } catch { return { messages: [] }; } }
function appendChat(p, items) { const c = readChat(p); c.messages.push(...items); if (c.messages.length > 200) c.messages = c.messages.slice(-200); try { fs.mkdirSync(path.dirname(chatFile(p)), { recursive: true }); fs.writeFileSync(chatFile(p), JSON.stringify(c)); } catch {} }
function sessFile(p) { return path.join(p.path, 'docs/.state/session.json'); }
function readSess(p) { try { return JSON.parse(fs.readFileSync(sessFile(p), 'utf8')).sessionId || null; } catch { return null; } }
function writeSess(p, id) { try { fs.mkdirSync(path.dirname(sessFile(p)), { recursive: true }); fs.writeFileSync(sessFile(p), JSON.stringify({ sessionId: id })); } catch {} }
// 每项目挂一个 claude 会话：有会话则 --resume 续聊（AI 记得上次）；resume 失败则回退新会话
// 生命周期（#8）：同项目同时只允许一个在跑（防双 --resume 会话分叉/历史互覆）；可被 stopRun 中止
const runningRuns = new Map(); // projId -> child
function runClaude(p, msg, cb) {
  if (runningRuns.has(p.id)) return cb({ reply: '', error: '该项目已有一个 AI 任务在运行，请等它结束或先停止' });
  let done = false;
  const finish = (r) => { if (done) return; done = true; runningRuns.delete(p.id); cb(r); };
  const attempt = (resumeId, isRetry) => {
    const args = ['-p', '--output-format', 'json', ...CLAUDE_EXTRA];
    if (resumeId) args.push('--resume', resumeId);
    const child = spawn(CLAUDE_BIN, args, { cwd: p.path, env: childEnv() });
    runningRuns.set(p.id, child);
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => finish({ reply: '', error: '无法启动 claude：' + e.message }));
    child.on('close', (code, signal) => {
      if (signal) return finish({ reply: '', error: '已停止（用户中止）' });   // 被 stopRun kill
      let reply = '', newSid = resumeId, isErr = false;
      try { const j = JSON.parse(out); reply = (j.result != null ? String(j.result) : '') || ''; if (j.session_id) newSid = j.session_id; isErr = !!j.is_error; }
      catch { reply = out.trim(); }
      if ((isErr || !reply) && resumeId && !isRetry) return attempt(null, true); // resume 失败 → 开新会话重试一次
      if (!reply) reply = err.trim() || '(无输出)';
      if (newSid) writeSess(p, newSid);
      finish({ reply, sessionId: newSid });
    });
    child.stdin.write(msg); child.stdin.end();
  };
  attempt(readSess(p), false);
}
function stopRun(projId) { const c = runningRuns.get(projId); if (c) { try { c.kill('SIGTERM'); } catch {} return true; } return false; }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // 跨源/DNS-rebinding 防护（#6）：拒绝非本机 Host、以及任何跨源页面发来的请求。
  // 同源 GET/HEAD 通常不带 Origin（放行）；同源 POST 带本机 Origin（放行）；跨源 POST 一定带攻击者 Origin（403）。
  if (!SELF_HOSTS.has(req.headers.host || '')) return send(res, 403, JSON.stringify({ error: 'forbidden host' }));
  if (req.headers.origin && !SELF_ORIGINS.has(req.headers.origin)) return send(res, 403, JSON.stringify({ error: 'cross-origin forbidden' }));
  const pid = url.searchParams.get('project');
  // --- API ---
  if (url.pathname === '/api/projects') return send(res, 200, JSON.stringify({ projects: loadProjects() }));
  if (url.pathname === '/api/board') {
    const p = projById(pid); if (!p) return send(res, 200, '{"specs":[]}');
    const f = path.join(p.path, 'docs/board.json');
    const finish = () => {
      let b; try { b = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return send(res, 200, '{"specs":[]}'); }
      for (const sp of (b.specs || [])) {   // 从 spec 文件头补 module（board.json 没存，给前端按模块分组用）
        if (!sp.module && sp.file) { try { const m = fs.readFileSync(path.join(p.path, sp.file), 'utf8').slice(0, 1200).match(/^module:\s*(.+)$/m); if (m) sp.module = m[1].trim(); } catch {} }
        if (sp.status === 'accepted' && sp.nodes) { for (const n of (b.nodes || [])) sp.nodes[n] = 'pass'; }   // 已验收/已完成 → 各节点全绿
      }
      return send(res, 200, JSON.stringify(b));
    };
    if (!fs.existsSync(f)) genBoard(p.path);   // 首次惰性生成（同步）
    return finish();
  }
  if (url.pathname === '/api/tasks') return send(res, 200, readOr(path.join(projById(pid).path, 'docs/tasks.json'), '{"groups":[]}'));
  if (url.pathname === '/api/spec') {
    const p = projById(pid), id = (url.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return send(res, 400, JSON.stringify({ error: '非法 spec id' }));
    const dir = path.join(p.path, 'docs/specs');
    let file = ''; try { file = fs.readdirSync(dir).find(f => f.endsWith('.md') && (f === id + '.md' || f.startsWith(id + '-') || f.startsWith(id + ' '))); } catch {}
    if (!file) return send(res, 404, JSON.stringify({ error: '找不到 spec 文件' }));
    let content = ''; try { content = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (e) { return send(res, 500, JSON.stringify({ error: e.message })); }
    return send(res, 200, JSON.stringify({ id, file, content }));
  }
  if (url.pathname === '/api/fs-list') {   // 服务端目录浏览（本地工具，给"选文件夹"用——浏览器拿不到绝对路径）
    let dir = url.searchParams.get('path') || os.homedir();
    try { dir = path.resolve(dir); } catch {}
    if (!fs.existsSync(dir)) dir = os.homedir();
    const wantFiles = url.searchParams.get('files') === '1';
    let dirs = [], files = [];
    try {
      const ents = fs.readdirSync(dir, { withFileTypes: true });
      dirs = ents
        .filter(d => { try { return d.isDirectory() || (d.isSymbolicLink() && fs.statSync(path.join(dir, d.name)).isDirectory()); } catch { return false; } })
        .map(d => d.name).filter(n => !n.startsWith('.')).sort((a, b) => a.localeCompare(b));
      if (wantFiles) files = ents
        .filter(d => { try { return d.isFile() || (d.isSymbolicLink() && fs.statSync(path.join(dir, d.name)).isFile()); } catch { return false; } })
        .map(d => d.name).filter(n => !n.startsWith('.')).sort((a, b) => a.localeCompare(b));
    } catch { return send(res, 200, JSON.stringify({ path: dir, parent: path.dirname(dir), dirs: [], files: [], error: '无法读取该目录' })); }
    const parent = path.dirname(dir);
    return send(res, 200, JSON.stringify({ path: dir, parent: parent === dir ? null : parent, dirs, files }));
  }
  if (url.pathname === '/api/agents') {
    const proj = projById(pid);
    let roster = { agents: [] };
    try { roster = JSON.parse(fs.readFileSync(path.join(proj.path, 'docs/.state/agents.json'), 'utf8')); } catch {}
    let board = {};
    try { board = JSON.parse(fs.readFileSync(path.join(proj.path, 'docs/board.json'), 'utf8')); } catch {}
    // 从看板节点实时派生“谁在干活”：节点=doing → 对应 agent=running
    const NA = { dev: ['dev', '开发'], test: ['dev', '测试'] };
    const doing = {};
    const STUCK_MS = 8 * 60 * 1000;
    for (const sp of (board.specs || [])) for (const node of Object.keys(NA)) if ((sp.nodes || {})[node] === 'doing') {
      let stale = false; try { stale = (Date.now() - fs.statSync(path.join(proj.path, 'docs/.state/' + sp.id + '.json')).mtimeMs) > STUCK_MS; } catch {}
      doing[NA[node][0]] = (stale ? '⚠ 疑似卡住·' : '正在') + NA[node][1] + '：' + sp.id + ' ' + (sp.title || '');
    }
    for (const a of (roster.agents || [])) { if (doing[a.id]) { a.status = 'running'; a.current = doing[a.id]; } else if (a.status === 'running') { a.status = 'idle'; a.current = ''; } }
    return send(res, 200, JSON.stringify(roster));
  }
  if (url.pathname === '/api/chat-history') return send(res, 200, JSON.stringify(readChat(projById(pid))));
  if (url.pathname === '/api/inbox') {
    const items = [];
    for (const proj of loadProjects()) {
      let b; try { b = JSON.parse(fs.readFileSync(path.join(proj.path, 'docs/board.json'), 'utf8')); } catch { continue; }
      for (const sp of (b.specs || [])) {
        const nodes = sp.nodes || {};
        if (nodes.accept === 'wait') items.push({ project: proj.id, projectName: proj.name, spec: sp.id, title: sp.title || '', kind: 'accept', label: '待最终验收' });
        else {
          const failed = Object.keys(nodes).find(n => nodes[n] === 'fail');
          if (failed) items.push({ project: proj.id, projectName: proj.name, spec: sp.id, title: sp.title || '', kind: 'fail', label: '需介入（' + failed + ' 失败）' });
          else { const doingNode = ['product', 'dev', 'test', 'review'].find(n => nodes[n] === 'doing'); if (doingNode) { let stale = false; try { stale = (Date.now() - fs.statSync(path.join(proj.path, 'docs/.state/' + sp.id + '.json')).mtimeMs) > 8 * 60 * 1000; } catch {} if (stale) items.push({ project: proj.id, projectName: proj.name, spec: sp.id, title: sp.title || '', kind: 'stuck', label: '疑似卡住（' + doingNode + ' 超 8 分钟无更新）' }); } }
        }
      }
      for (const bk of (b.blockers || [])) items.push({ project: proj.id, projectName: proj.name, spec: '', title: bk, kind: 'decision', label: '需决策' });
    }
    return send(res, 200, JSON.stringify({ items }));
  }
  if (url.pathname === '/api/accept' && req.method === 'POST') {
    const p = projById(pid); let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => {
      let spec = ''; try { spec = (JSON.parse(buf).spec || '').trim(); } catch {}
      if (!/^[A-Za-z0-9_-]+$/.test(spec)) return send(res, 400, JSON.stringify({ ok: false, error: '非法 spec' }));
      // 1) spec 头部 status -> accepted（只在 frontmatter 块内替换）
      const dir = path.join(p.path, 'docs/specs');
      let file = ''; try { file = fs.readdirSync(dir).find(f => f.endsWith('.md') && (f === spec + '.md' || f.startsWith(spec + '-') || f.startsWith(spec + ' '))); } catch {}
      if (!file) return send(res, 404, JSON.stringify({ ok: false, error: '找不到 spec 文件' }));
      const fp = path.join(dir, file);
      try {
        let txt = fs.readFileSync(fp, 'utf8');
        const m = txt.match(/^(---\n)([\s\S]*?)(\n---)/);
        if (m) {
          let fm = m[2];
          fm = /^status:/m.test(fm) ? fm.replace(/^status:[ \t]*.*$/m, 'status: accepted') : fm + '\nstatus: accepted';
          txt = m[1] + fm + m[3] + txt.slice(m[0].length);
          fs.writeFileSync(fp, txt);
        }
      } catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: '写 spec 失败：' + e.message })); }
      // 2) 状态文件 accept -> pass
      const sf = path.join(p.path, 'docs/.state', spec + '.json');
      let st = {}; try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {}
      st.nodes = Object.assign({}, st.nodes, { accept: 'pass' });
      try { fs.mkdirSync(path.dirname(sf), { recursive: true }); fs.writeFileSync(sf, JSON.stringify(st, null, 2)); } catch {}
      // 3) 重算 board
      genBoard(p.path);
      return send(res, 200, JSON.stringify({ ok: true }));
    });
    return;
  }
  if (url.pathname === '/api/spec-patch' && req.method === 'POST') {   // 直接改 spec frontmatter 的纯数据字段（状态/优先级）；语义后果类操作走预填编排器，不在这里
    const p = projById(pid);
    if (!p) return send(res, 400, JSON.stringify({ ok: false, error: '尚未纳管任何项目' }));
    let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => {
      let b = {}; try { b = JSON.parse(buf); } catch {}
      const spec = (b.spec || '').trim(), field = (b.field || '').trim(), value = (b.value || '').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(spec)) return send(res, 400, JSON.stringify({ ok: false, error: '非法 spec' }));
      const ALLOW = { status: ['draft', 'ready', 'in-dev', 'testing', 'accepted'], priority: ['P0', 'P1', 'P2', 'P3', 'Must', 'Should', 'Could'] };
      if (!ALLOW[field]) return send(res, 400, JSON.stringify({ ok: false, error: '该字段不可直接改（语义字段请走编排器）' }));
      if (!ALLOW[field].includes(value)) return send(res, 400, JSON.stringify({ ok: false, error: '非法值' }));
      const dir = path.join(p.path, 'docs/specs');
      let file = ''; try { file = fs.readdirSync(dir).find(f => f.endsWith('.md') && (f === spec + '.md' || f.startsWith(spec + '-') || f.startsWith(spec + ' '))); } catch {}
      if (!file) return send(res, 404, JSON.stringify({ ok: false, error: '找不到 spec 文件' }));
      const fp = path.join(dir, file);
      try {
        let txt = fs.readFileSync(fp, 'utf8');
        const m = txt.match(/^(---\n)([\s\S]*?)(\n---)/);
        if (!m) return send(res, 400, JSON.stringify({ ok: false, error: 'spec 缺少 frontmatter' }));
        let fm = m[2];
        const re = new RegExp('^' + field + ':[ \\t]*.*$', 'm');
        fm = re.test(fm) ? fm.replace(re, field + ': ' + value) : fm + '\n' + field + ': ' + value;
        txt = m[1] + fm + m[3] + txt.slice(m[0].length);
        fs.writeFileSync(fp, txt);
      } catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: '写 spec 失败：' + e.message })); }
      genBoard(p.path);
      return send(res, 200, JSON.stringify({ ok: true }));
    });
    return;
  }
  if (url.pathname === '/api/spec-merge' && req.method === 'POST') {   // 合并 spec：选好目标后，后端直接调 LLM 执行（不经 CLI 窗口）
    const p = projById(pid);
    if (!p) return send(res, 400, JSON.stringify({ ok: false, error: '尚未纳管任何项目' }));
    let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => {
      let b = {}; try { b = JSON.parse(buf); } catch {}
      const from = (b.from || '').trim(), to = (b.to || '').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(from) || !/^[A-Za-z0-9_-]+$/.test(to)) return send(res, 400, JSON.stringify({ ok: false, error: '非法 spec' }));
      if (from === to) return send(res, 400, JSON.stringify({ ok: false, error: '不能合并到自己' }));
      const prompt = `把 spec ${from} 合并进 spec ${to}，**直接执行改文件，不要只给建议**：\n`
        + `1) 读 docs/specs 下这两条；按 CLAUDE.md §4.6 算影响面（谁 depends_on ${from}、共享表/接口/同模块）。\n`
        + `2) 把 ${from} 的范围/AC/接口契约/数据契约/测试要点合并进 ${to}（去重、保留更严的约束），并更新 ${to} 标题/描述使其涵盖两者。\n`
        + `3) 所有 depends_on 里指向 ${from} 的改为指向 ${to}。\n`
        + `4) 删除 ${from} 的 spec 文件与 docs/.state/${from}.json。\n`
        + `5) 跑 node tools/board.mjs 重算看板。\n`
        + `最后一句话回我：合并了什么、改了哪些受影响 spec、删了哪个文件。`;
      runClaude(p, prompt, (out) => {
        genBoard(p.path); sseBroadcast({ type: 'refresh' });
        if (out.error) return send(res, 500, JSON.stringify({ ok: false, error: out.error }));
        send(res, 200, JSON.stringify({ ok: true, reply: out.reply || '' }));
      });
    });
    return;
  }
  if (url.pathname === '/api/run-stop' && req.method === 'POST') {   // 中止该项目正在跑的 AI 任务（#8）
    const p = projById(pid);
    return send(res, 200, JSON.stringify({ ok: p ? stopRun(p.id) : false }));
  }
  if (url.pathname === '/api/terminals') return send(res, 200, JSON.stringify({ ttyd: !!TTYD_BIN }));
  if (url.pathname === '/api/windows') { const pp = url.searchParams.get('project'); const ws = [...openWindows.values()].filter(w => w.projectId === pp).map(w => ({ key: w.key, port: w.port, label: w.label, title: w.title || '', sessionId: w.sessionId, busy: !!w.busy, confirm: !!w.confirm, done: !!w.done, activity: w.activity || '' })); return send(res, 200, JSON.stringify({ windows: ws })); }
  if (url.pathname === '/api/window-seen' && req.method === 'POST') { let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => { let k = ''; try { k = String(JSON.parse(buf).key || ''); } catch {} const w = openWindows.get(k); if (w) w.done = false; send(res, 200, JSON.stringify({ ok: true })); }); return; }
  if (url.pathname === '/api/window-send' && req.method === 'POST') {   // 往某终端窗口发命令（等 claude 就绪再发，后台进行，立即返回）
    let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => {
      let b = {}; try { b = JSON.parse(buf); } catch {}
      const w = openWindows.get(String(b.key || '')); const text = String(b.text || ''); const enter = b.enter !== false;
      if (!w || !w.tmuxSess || !TMUX_BIN || !text) return send(res, 200, JSON.stringify({ ok: false, error: 'no window/text' }));
      send(res, 200, JSON.stringify({ ok: true, queued: true }));
      let tries = 0;
      const trySend = () => {
        const pane = capturePane(w.tmuxSess);
        const ready = /bypass permissions|shift\+tab|❯/.test(pane);
        if (!ready && tries++ < 30) return void setTimeout(trySend, 800);   // 最多等 ~24s claude 起好
        try { spawnSync(TMUX_BIN, ['-L', TMUX_SOCK, 'send-keys', '-t', w.tmuxSess, '-l', text]); } catch {}
        if (enter) setTimeout(() => { try { spawnSync(TMUX_BIN, ['-L', TMUX_SOCK, 'send-keys', '-t', w.tmuxSess, 'Enter']); } catch {} }, 400);
      };
      setTimeout(trySend, 1500);
    });
    return;
  }
  if (url.pathname === '/api/open-window' && req.method === 'POST') {
    if (!TTYD_BIN) return send(res, 400, JSON.stringify({ error: '未安装 ttyd' }));
    let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => { let b = {}; try { b = JSON.parse(buf); } catch {} const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ error: '尚未纳管任何项目，请先「新增项目」' })); const r = openWindow(proj, (b.sessionId || '').trim(), b.label || '新对话'); waitForPort(r.port, () => send(res, 200, JSON.stringify(r))); });
    return;
  }
  if (url.pathname === '/api/close-window' && req.method === 'POST') {
    let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => { let b = {}; try { b = JSON.parse(buf); } catch {} closeWindow(String(b.key || '')); send(res, 200, JSON.stringify({ ok: true })); });
    return;
  }
  if (url.pathname === '/api/claude-sessions') { const abs = url.searchParams.get('path') || ''; return send(res, 200, JSON.stringify({ sessions: abs ? listClaudeSessions(abs) : [] })); }
  if (url.pathname === '/api/commands') {   // 该项目可用的斜杠命令（读 .claude/commands/*.md 的名字+description）
    const p = projById(pid); const dir = path.join(p.path, '.claude/commands'); const out = [];
    try { for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.md')) continue; let desc = ''; try { const m = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 800).match(/^description:\s*(.+)$/m); if (m) desc = m[1].trim(); } catch {} out.push({ name: f.replace(/\.md$/, ''), desc }); } } catch {}
    out.sort((a, b) => a.name.localeCompare(b.name));
    return send(res, 200, JSON.stringify({ commands: out }));
  }
  if (url.pathname === '/api/claude-session-delete' && req.method === 'POST') {
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => {
      let abs = '', id = ''; try { const b = JSON.parse(buf); abs = b.path || ''; id = b.id || ''; } catch {}
      if (!abs || !/^[A-Za-z0-9_-]+$/.test(id)) return send(res, 400, JSON.stringify({ ok: false, error: 'bad path/id' }));
      const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(abs));
      const fp = path.join(dir, id + '.jsonl');
      if (!fp.startsWith(dir + path.sep) || !fs.existsSync(fp)) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      try { fs.unlinkSync(fp); return send(res, 200, JSON.stringify({ ok: true })); }
      catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) })); }
    });
    return;
  }
  if (url.pathname === '/api/project-add' && req.method === 'POST') {
    let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => {
      let b = {}; try { b = JSON.parse(buf); } catch {}
      const id = (b.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, ''), name = (b.name || '').trim(), dest = (b.path || '').trim(), sessionId = (b.sessionId || '').trim();
      const mode = (b.mode || 'existing').trim(), prdPath = (b.prdPath || '').trim(), protoDir = (b.protoDir || '').trim(), gitUrl = (b.gitUrl || '').trim();
      if (!id || !name || !dest) return send(res, 400, JSON.stringify({ error: 'id / 名称 / 路径 均必填（id 仅限字母数字-_）' }));
      if (!path.isAbsolute(dest)) return send(res, 400, JSON.stringify({ error: '路径需为绝对路径' }));
      if (loadProjects().find(p => p.id === id)) return send(res, 400, JSON.stringify({ error: '项目 id 已存在' }));
      // Git 导入：先 clone 到 dest（异步，不阻塞事件循环），成功后再走下面的纳管流程
      if (mode === 'git') {
        if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(gitUrl)) return send(res, 400, JSON.stringify({ error: 'Git 地址格式不对（需 http(s):// / git@ / ssh:// / file://）' }));
        let nonEmpty = false; try { nonEmpty = fs.existsSync(dest) && fs.readdirSync(dest).length > 0; } catch {}
        if (nonEmpty) return send(res, 400, JSON.stringify({ error: '克隆目标目录已存在且非空，请换一个空目录' }));
        try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}
        const git = spawn('git', ['clone', gitUrl, dest], { stdio: 'ignore' });   // 不覆盖 env：继承 SSH/凭证；args 数组无 shell 注入
        git.on('error', e => send(res, 500, JSON.stringify({ error: '无法启动 git：' + e.message })));
        git.on('close', code => { if (code !== 0) return send(res, 500, JSON.stringify({ error: 'git clone 失败（退出码 ' + code + '）：检查地址 / 网络 / 凭证' })); finalize(); });
        return;
      }
      finalize();
      function finalize() {
      try {
        // 判断是否"导入已有代码库"：目录已存在且里面有非脚手架内容（用于决定是否提示扫描建 spec）
        let existed = false; try { existed = fs.existsSync(dest) && fs.readdirSync(dest).some(n => !['docs', 'tools', '.claude', 'CLAUDE.md', '.git'].includes(n)); } catch {}
        fs.mkdirSync(dest, { recursive: true });
        scaffoldProject(dest, name, id);
        // 绿地：把选好的 PRD/原型拷进项目（PRD→docs/PRD<ext>，原型→docs/prototype/）
        let prdImported = false, protoImported = 0;
        if (mode === 'greenfield') {
          fs.mkdirSync(path.join(dest, 'docs/prototype'), { recursive: true });
          if (prdPath && path.isAbsolute(prdPath)) { try { if (fs.statSync(prdPath).isFile()) { fs.copyFileSync(prdPath, path.join(dest, 'docs/PRD' + (path.extname(prdPath) || '.md'))); prdImported = true; } } catch {} }
          if (protoDir && path.isAbsolute(protoDir)) { try { if (fs.statSync(protoDir).isDirectory()) protoImported = copyDirAll(protoDir, path.join(dest, 'docs/prototype')); } catch {} }
        }
        if (sessionId) fs.writeFileSync(path.join(dest, 'docs/.state/session.json'), JSON.stringify({ sessionId }));
        let j = { projects: [] }; try { j = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch {}
        if (!j.projects) j.projects = []; j.projects.push({ id, name, path: dest }); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(j, null, 2));
        const p = { id, name, path: dest };
        watchProject(p); genBoard(dest);
        // 已有 spec 数（团队成员 clone 下来再导入时：specs 已在，无需再 /scan）
        let specCount = 0; try { specCount = fs.readdirSync(path.join(dest, 'docs/specs')).filter(n => n.endsWith('.md') && !['_TEMPLATE.md', 'README.md'].includes(n)).length; } catch {}
        send(res, 200, JSON.stringify({ ok: true, id, existed, mode, prdImported, protoImported, specCount }));
      } catch (e) { send(res, 500, JSON.stringify({ error: e.message })); }
      }   // end finalize
    });
    return;
  }
  if (url.pathname === '/api/project-remove' && req.method === 'POST') {   // 移除项目 = 取消纳管 + 关该项目终端；不删磁盘文件
    let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => {
      let id = ''; try { id = (JSON.parse(buf).id || '').trim(); } catch {}
      if (!id) return send(res, 400, JSON.stringify({ error: '缺少 id' }));
      let j = { projects: [] }; try { j = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch {}
      if (!j.projects) j.projects = [];
      const before = j.projects.length;
      j.projects = j.projects.filter(p => p.id !== id);
      if (j.projects.length === before) return send(res, 400, JSON.stringify({ error: '项目不存在' }));
      try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(j, null, 2)); } catch (e) { return send(res, 500, JSON.stringify({ error: e.message })); }
      for (const w of [...openWindows.values()]) if (w.projectId === id) closeWindow(w.key);   // 杀该项目的 ttyd + tmux
      unwatchProject(id);
      sseBroadcast({ type: 'refresh' });
      send(res, 200, JSON.stringify({ ok: true, id }));
    });
    return;
  }
  if (url.pathname === '/api/chat-clear' && req.method === 'POST') { const p = projById(pid); try { fs.writeFileSync(chatFile(p), JSON.stringify({ messages: [] })); writeSess(p, null); } catch {} return send(res, 200, JSON.stringify({ ok: true })); }
  if (url.pathname === '/api/chat-delete' && req.method === 'POST') {
    const p = projById(pid); let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => {
      let idx = -1; try { idx = JSON.parse(buf).index; } catch {}
      const c = readChat(p);
      if (Number.isInteger(idx) && idx >= 0 && idx < c.messages.length) {
        c.messages.splice(idx, 1);
        try { fs.mkdirSync(path.dirname(chatFile(p)), { recursive: true }); fs.writeFileSync(chatFile(p), JSON.stringify(c)); } catch {}
        return send(res, 200, JSON.stringify({ ok: true, count: c.messages.length }));
      }
      return send(res, 400, JSON.stringify({ ok: false, error: 'bad index' }));
    });
    return;
  }
  if (url.pathname === '/api/prompt-file') {   // 查看/编辑内置提示词：命令 .md / agent .md / CLAUDE.md（白名单 + 防穿越）
    const p = projById(pid); if (!p) return send(res, 400, JSON.stringify({ error: '尚未纳管任何项目' }));
    const kind = (url.searchParams.get('kind') || '').trim();
    const name = (url.searchParams.get('name') || '').replace(/[^a-z0-9_-]/gi, '');
    let rel = '';
    if (kind === 'command' && name) rel = '.claude/commands/' + name + '.md';
    else if (kind === 'agent' && name) rel = '.claude/agents/' + name + '.md';
    else if (kind === 'manual') rel = 'CLAUDE.md';
    else return send(res, 400, JSON.stringify({ error: '参数错误' }));
    const f = path.join(p.path, rel);
    if (req.method === 'GET') return send(res, 200, JSON.stringify({ rel, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }));
    if (req.method === 'POST') {
      let buf = ''; req.on('data', c => (buf += c)); req.on('end', () => {
        try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, (JSON.parse(buf).content) ?? ''); send(res, 200, JSON.stringify({ ok: true })); }
        catch (e) { send(res, 500, JSON.stringify({ error: e.message })); }
      });
      return;
    }
    return;
  }
  if (url.pathname === '/api/agent-file') {
    const p = projById(pid);
    const id = (url.searchParams.get('id') || '').replace(/[^a-z0-9_-]/gi, '');   // 防路径穿越
    if (!id) return send(res, 400, JSON.stringify({ error: 'bad id' }));
    const f = path.join(p.path, '.claude/agents/' + id + '.md');
    if (req.method === 'GET') return send(res, 200, JSON.stringify({ id, path: '.claude/agents/' + id + '.md', content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }));
    if (req.method === 'POST') {
      let buf = '';
      req.on('data', c => (buf += c));
      req.on('end', () => {
        try {
          const body = JSON.parse(buf);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, body.content ?? '');
          send(res, 200, JSON.stringify({ ok: true }));
        } catch (e) { send(res, 500, JSON.stringify({ error: e.message })); }
      });
      return;
    }
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    sseClients.add(res); req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const p = projById(pid);
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => {
      let msg = '';
      try { msg = JSON.parse(buf).message || ''; } catch {}
      if (!msg) return send(res, 400, JSON.stringify({ error: 'empty message' }));
      send(res, 200, JSON.stringify({ started: true }));   // 立即返回，输出走 SSE 流式推送
      const sid = readSess(p);
      const args = ['-p', '--output-format', 'stream-json', '--verbose', ...CLAUDE_EXTRA];
      if (sid) args.push('--resume', sid);
      const child = spawn(CLAUDE_BIN, args, { cwd: p.path, env: childEnv() });
      let finalReply = '', newSid = sid, lineBuf = '';
      const emit = (kind, text) => sseBroadcast({ type: 'chat', project: p.id, kind, text });
      child.stdout.on('data', d => {
        lineBuf += d; let i;
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, i).trim(); lineBuf = lineBuf.slice(i + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.session_id) newSid = ev.session_id;
          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const b of ev.message.content) {
              if (b.type === 'text' && b.text && b.text.trim()) { emit('text', b.text.trim()); finalReply = b.text.trim(); }
              else if (b.type === 'tool_use') { const sub = b.input && b.input.subagent_type ? ' · ' + b.input.subagent_type : ''; emit('tool', '🔧 ' + (b.name || 'tool') + sub); }
            }
          } else if (ev.type === 'result' && ev.result) { finalReply = ev.result; }
        }
      });
      child.on('error', e => { emit('done', '无法启动 claude：' + e.message); });
      child.on('close', () => {
        if (newSid) writeSess(p, newSid);
        appendChat(p, [{ role: 'user', text: msg, ts: Date.now() }, { role: 'ai', text: finalReply || '(完成)', ts: Date.now() }]);
        emit('done', finalReply || '(完成)');
      });
      child.stdin.write(msg); child.stdin.end();
    });
    return;
  }
  // --- 静态（dashboard 从宿主目录）---
  let rel = url.pathname === '/' ? '/dashboard/index.html' : url.pathname;
  const file = path.join(ROOT, rel);
  if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {   // no-store：改了 UI 立刻生效，不吃浏览器旧缓存（#9）
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }
  send(res, 404, 'Not Found', 'text/plain');
});

// 监听项目 docs/ 变更 → 重算该项目 board + SSE 推送（忽略 board.* 防回环）
let _deb = null;
const watchers = new Map(); // projectId -> FSWatcher（移除项目时关掉）
function watchProject(p) {
  try {
    const w = fs.watch(path.join(p.path, 'docs'), { recursive: true }, (ev, fn) => {
      if (fn && /board\.(json|md)$/.test(fn)) return;
      clearTimeout(_deb);
      _deb = setTimeout(() => { genBoard(p.path); sseBroadcast({ type: 'refresh' }); }, 300);
    });
    watchers.set(p.id, w);
  } catch {}
}
function unwatchProject(id) { const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); } }
for (const p of loadProjects()) watchProject(p);

// 启动期的子进程 spawn（genBoard / adopt 起 ttyd）放在 server.listen 之前：
// 避免「spawn 子进程」与「监听 socket 接受连接」在同一瞬间抢 fd，导致该实例后续请求体处理异常（间歇 400）。
for (const p of loadProjects()) genBoard(p.path);
adoptWindows();   // 接管上次遗留/重启前存活的 tmux 会话
server.on('clientError', (err, socket) => { try { console.error('[clientError]', err?.code, err?.message, 'bytesParsed=', err?.bytesParsed, 'rawPacket=', err?.rawPacket ? JSON.stringify(err.rawPacket.toString('utf8').slice(0, 200)) : ''); } catch {} try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Steward 控制台（多项目）： http://127.0.0.1:${PORT}`);
  console.log(TTYD_BIN ? '  内嵌终端(ttyd) 就绪：每个项目可开多个对话窗口' : '  内嵌终端未启用：未找到 ttyd（brew install ttyd 后重启）');
  console.log('  (Ctrl+C 退出)\n');
});
