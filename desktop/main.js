// Steward 桌面客户端主进程（Electron）
// 职责：① fork 现有 tools/server.mjs（spec/board/todo/feishu 等 API 原样复用）
//      ② 开窗口加载控制台 ③ 用 node-pty 跑 claude（替代 ttyd+tmux，mac/win 原生）
//      ④ 注入 native-term.js：在渲染端用 xterm.js + IPC 覆盖终端逻辑
const { app, BrowserWindow, ipcMain, Notification, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { fork, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

// 代码热更新(#32)：壳(Electron+node-pty+xterm)不变，只更 tools/dashboard/templates(纯 JS/HTML)。
// ROOT 优先用 userData 里下载校验过的新代码(且壳兼容)，否则用内置；任何异常一律回退内置，绝不让 app 起不来。
const BUILTIN_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'steward') : path.resolve(__dirname, '..');
const CODE_DIR = path.join(app.getPath('userData'), 'steward-code');
function cmpVer(a, b) { const p = s => String(s || '').replace(/^v/, '').split('.').map(n => parseInt(n) || 0); const x = p(a), y = p(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }
function resolveRoot() {
  try {
    if (app.isPackaged && fs.existsSync(path.join(CODE_DIR, 'tools', 'server.mjs')) && fs.existsSync(path.join(CODE_DIR, 'dashboard', 'index.html'))) {
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(CODE_DIR, 'version.json'), 'utf8')); } catch {}
      const shellOk = !meta.requiresShell || cmpVer(app.getVersion(), meta.requiresShell) >= 0;
      // 关键:热更代码必须严格新于当前壳(=dmg)版本才用它，否则用内置 → 装了新 dmg 一定生效，旧热更代码不再压过新包
      if (meta.version && shellOk && cmpVer(meta.version, 'v' + app.getVersion()) > 0) return CODE_DIR;
    }
  } catch {}
  return BUILTIN_ROOT;
}
const ROOT = resolveRoot();
const UPDATE_BASE = 'https://github.com/xinyessl/steward/releases/latest/download';   // 只认官方 Release(HTTPS) + 下面 SHA256 校验
function currentCodeVersion() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version || ('v' + app.getVersion()); } catch { return 'v' + app.getVersion(); } }
const SERVER = path.join(ROOT, 'tools', 'server.mjs');
const PORT = process.env.PORT || 51790;   // 桌面端用 51790，避开 web 版的 51780（同时开也不撞）
let serverProc = null, mainWin = null;

// ===== claude 状态钩子(权威态，替代屏幕猜测) =====
// 用 claude Code 的 hooks(UserPromptSubmit→忙 / Stop→闲 / Notification→等确认)写状态文件，steward 读它显示状态。
// 路径放 ~/.steward/cli-state(无空格，跨平台安全)；启动 claude 时 --settings 叠加这套 hooks(不污染用户配置) + 注入 STEWARD_WIN。
const STATE_DIR = path.join(os.homedir(), '.steward', 'cli-state');
const HOOK_SCRIPT = path.join(STATE_DIR, 'report-state.cjs');
const HOOK_SETTINGS = path.join(STATE_DIR, 'hooks.json');
function writeHookFiles() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // hook 脚本:按 STEWARD_WIN 把状态写到 <dir>/<key>.json;并从 stdin 的 JSON 读 session_id 一并记下(供重命名按会话持久化)
    fs.writeFileSync(HOOK_SCRIPT, `const fs=require('fs'),path=require('path');let sid='';try{sid=(JSON.parse(fs.readFileSync(0,'utf8'))||{}).session_id||''}catch(e){}const st=process.argv[2]||'idle';const k=process.env.STEWARD_WIN,d=process.env.STEWARD_STATE_DIR;if(k&&d){try{fs.mkdirSync(d,{recursive:true});const f=path.join(d,k+'.json');let prev={};try{prev=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}fs.writeFileSync(f,JSON.stringify({state:st,session:sid||prev.session||'',ts:Date.now()}))}catch(e){}}\n`);
    const cmd = s => ({ type: 'command', command: `node "${HOOK_SCRIPT}" ${s}` });
    const evt = s => [{ matcher: '', hooks: [cmd(s)] }];
    const settings = { hooks: {
      SessionStart: evt('idle'),
      UserPromptSubmit: evt('doing'),
      Stop: evt('idle'),
      Notification: [{ matcher: 'permission_prompt', hooks: [cmd('waiting')] }],
    } };
    fs.writeFileSync(HOOK_SETTINGS, JSON.stringify(settings));
  } catch (e) { console.error('[hook] 写钩子文件失败', e && e.message); }
}
writeHookFiles();
function readHookState(key) { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, key + '.json'), 'utf8')); } catch { return null; } }

// ---------- 1) 起后端（electron 当 node 跑 server.mjs，所有非终端 API 原样可用） ----------
function startServer() {
  serverProc = fork(SERVER, [], {
    // 注入登录 shell 的真实 PATH：否则 GUI 精简 PATH 找不到 nvm 里的 claude，
    // health 探活会误报"未登录"，且 /accept、合并 spec 等后端调 claude 的功能也会失败
    env: { ...process.env, PATH: SHELL_PATH || process.env.PATH, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), STEWARD_NATIVE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  serverProc.on('exit', c => console.log('[server] exited', c));
}
function waitServer(cb, tries = 0) {
  http.get(`http://127.0.0.1:${PORT}/api/projects`, r => { r.resume(); cb(); })
    .on('error', () => tries < 80 ? setTimeout(() => waitServer(cb, tries + 1), 150) : cb());
}

// ---------- 2) node-pty 跑 claude（每个窗口一个 pty） ----------
let pty, HeadlessTerm;
try { pty = require('node-pty'); } catch (e) { console.error('node-pty 未就绪：', e.message); }
try { HeadlessTerm = require('@xterm/headless').Terminal; } catch {}

// macOS GUI 应用拿到的是精简 PATH（不含 nvm/homebrew 等）→ 用登录 shell 取真实 PATH
function loginPath() {
  if (process.platform === 'win32') return process.env.PATH || '';
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const o = (spawnSync(sh, ['-lic', 'echo __SP__:$PATH'], { encoding: 'utf8', timeout: 6000 }).stdout || '');
    const m = o.match(/__SP__:(.+)/);
    if (m && m[1].includes('/')) return m[1].trim();
  } catch {}
  return process.env.PATH || '';
}
const SHELL_PATH = loginPath();
function findClaude() {
  const exes = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  for (const dir of SHELL_PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exes) { const p = path.join(dir, e); try { if (fs.existsSync(p)) return p; } catch {} }
  }
  for (const c of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local/bin/claude')]) if (fs.existsSync(c)) return c;
  return 'claude';
}
const CLAUDE = findClaude();
console.log('[steward] claude =', CLAUDE);
const EXTRA = (process.env.CLAUDE_EXTRA || '--dangerously-skip-permissions').split(' ').filter(Boolean);

const ptys = new Map();   // key -> { proc, term(headless), lastSig, busy, confirm, title, activity, projectId, cwd }

function serialize(term) {
  if (!term) return '';
  const b = term.buffer.active, rows = term.rows; const base = b.baseY; const out = [];
  for (let i = 0; i < rows; i++) { const ln = b.getLine(base + i); out.push(ln ? ln.translateToString(true) : ''); }
  return out.join('\n');
}
// 与 server.mjs 同套启发式：判忙/判等确认/抽话题与在干啥
function sig(s) { return s.split('\n').filter(l => !l.includes('⠀') && !l.includes('⏵⏵') && !/^\s*\d+h\s/.test(l) && !/^[\s─-]*$/.test(l)).join('\n'); }
function isConfirm(s) {
  // 只看 live 提示区(最后 ~6 行非空)+ 窄信号:y/n、编号菜单光标(❯ 1.)、英文权限框。
  // 不再匹配中文散文(是否/确认/?)——claude 确认框是英文 UI/编号菜单，中文叙述会误报(#33)
  const tail = s.split('\n').map(l => l.trim()).filter(Boolean).slice(-6).join('\n');
  return /\([yY]\/[nN]\)|\[[yY]\/[nN]\]|❯\s*\d+[.\)]|\bDo you want to (proceed|continue)|press \w+ to (confirm|continue)/i.test(tail);
}

// cwd 白名单：只允许「不传(→ homedir 默认)」或「某个已纳管项目目录及其子目录」——
// 即便渲染进程被 XSS 攻破，也无法在任意目录起 --dangerously-skip-permissions 的 claude(#26)
function allowedCwd(cwd) {
  if (!cwd) return true;
  let real; try { real = fs.realpathSync(cwd); } catch { return false; }
  const dataDir = process.env.STEWARD_DATA || path.join(os.homedir(), '.steward');
  let paths = [];
  try { paths = (JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).projects || []).map(p => p.path); } catch {}
  return paths.some(p => { try { const rp = fs.realpathSync(p); return real === rp || real.startsWith(rp + path.sep); } catch { return false; } });
}
function ptyCreate(e, { key, projectId, cwd, sessionId }) {
  if (!pty) return { ok: false, error: 'node-pty 未安装/未编译，先在 desktop/ 跑 npm install' };
  if (ptys.has(key)) return { ok: true };
  if (!allowedCwd(cwd)) return { ok: false, error: 'cwd 不在已纳管项目范围内，已拒绝(安全)' };
  const args = [...EXTRA]; if (sessionId) args.push('--resume', sessionId);
  if (fs.existsSync(HOOK_SETTINGS)) args.push('--settings', HOOK_SETTINGS);   // 叠加状态钩子(不污染用户配置);文件没写成则不加，绝不因此起不来
  const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  let proc;
  try {
    const opts = { name: 'xterm-256color', cols: 100, rows: 30, cwd: cwd || os.homedir(), env: { ...process.env, PATH: SHELL_PATH || process.env.PATH, STEWARD_WIN: key, STEWARD_STATE_DIR: STATE_DIR } };
    if (process.platform === 'win32') {
      // claude 是 .cmd shim，ConPTY/CreateProcess 不能直接跑 .cmd → 经 cmd.exe /c 启动(按 PATHEXT 解析 .cmd)
      proc = pty.spawn(process.env.COMSPEC || 'cmd.exe', ['/c', ['claude', ...args].join(' ')], opts);
    } else {
      // 经登录 shell exec：PATH/node/claude 的解析与你终端完全一致，避开 GUI 精简 PATH + nvm shebang(#!/usr/bin/env node) 导致的 posix_spawn 失败
      const sh = process.env.SHELL || '/bin/zsh';
      proc = pty.spawn(sh, ['-lic', 'exec ' + [CLAUDE, ...args].map(shq).join(' ')], opts);
    }
  } catch (err) {
    console.error('[pty] spawn 失败：', { CLAUDE, shell: process.env.SHELL, platform: process.platform, msg: err && err.message, stack: err && err.stack });
    return { ok: false, error: 'claude 启动失败：' + (err && err.message) };
  }
  const term = HeadlessTerm ? new HeadlessTerm({ cols: 100, rows: 30, allowProposedApi: true }) : null;
  const rec = { proc, term, lastSig: undefined, busy: false, confirm: false, title: '', activity: '', projectId, cwd, sessionId: sessionId || '' };
  ptys.set(key, rec);
  try { fs.writeFileSync(path.join(STATE_DIR, key + '.json'), JSON.stringify({ state: 'init', ts: Date.now() })); } catch {}   // 初始 init(非 idle):区分"钩子还没触发"(走屏幕兜底) vs "钩子说空闲"(信钩子)
  const sendWin = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) { try { mainWin.webContents.send(ch, payload); } catch {} } };   // 窗口可能已销毁(关闭时 pty 还在吐数据)→ 守卫，否则 Object has been destroyed
  proc.onData(d => { rec.lastDataAt = Date.now(); if (term) { try { term.write(d); } catch {} } sendWin('pty-data', { key, data: d }); });   // 原始数据流时刻:claude 一输出就更新,最可靠的"在干活"信号(不依赖屏幕解析)
  proc.onExit(() => { ptys.delete(key); try { fs.rmSync(path.join(STATE_DIR, key + '.json'), { force: true }); } catch {} sendWin('pty-exit', { key }); });
  return { ok: true };
}

// 周期性算忙/闲/确认（渲染端轮询取）
// 原生通知：窗口里 claude 停下等确认(false→true)时，弹系统通知告知你
let activeKey = null;   // 渲染端正在看的 tab(activate 时上报)
ipcMain.handle('pty-set-active', (e, { key }) => { activeKey = key; });
// 从屏幕里抽出"claude 在问什么"，放进通知正文
function extractAsk(screen) {
  const lines = (screen || '').split('\n').map(l => l.trim())
    .filter(l => l && !l.includes('⠀') && !l.includes('⏵⏵') && !/^\d+h\s/.test(l) && !/^[─\-]+$/.test(l));
  const tail = lines.slice(-14);
  for (let i = tail.length - 1; i >= 0; i--) if (/[?？]\s*$/.test(tail[i]) || /是否|确认|continue|proceed/i.test(tail[i])) return tail[i].slice(0, 70);   // 优先问句
  const cur = [...tail].reverse().find(l => /^❯\s*\d/.test(l));   // 否则当前选中项
  return ((cur || tail[tail.length - 1] || '').replace(/^❯\s*/, '')).slice(0, 70);
}
function notifyConfirm(r, key) {
  try {
    if (!Notification.isSupported()) return;
    // 窗口在前台(聚焦且没最小化)= 你正看着，不弹；最小化 / 后台 / 失焦 → 弹
    if (mainWin && !mainWin.isDestroyed() && mainWin.isFocused() && !mainWin.isMinimized()) return;
    if (r.lastNotify && Date.now() - r.lastNotify < 20000) return;                                // 20s 冷却，防抖
    r.lastNotify = Date.now();
    const ask = r.term ? extractAsk(serialize(r.term)) : '';
    const proj = r.projectId ? '【' + r.projectId + '】' : '';
    const n = new Notification({ title: 'Steward · 需要你确认 ' + proj, body: ask ? ('claude：' + ask) : 'claude 正在等待你确认/选择 —— 点开处理' });
    n.on('click', () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } });
    n.show();
  } catch {}
}
function notifyDone(r, key) {   // 某窗口干完(忙→闲) → 弹通知。仅当 app 不在前台(你不在看)才弹，避免打扰
  try {
    if (!Notification.isSupported()) return;
    if (mainWin && !mainWin.isDestroyed() && mainWin.isFocused() && !mainWin.isMinimized()) return;
    if (r.lastDoneNotify && Date.now() - r.lastDoneNotify < 20000) return;
    r.lastDoneNotify = Date.now();
    const proj = r.projectId ? '【' + r.projectId + '】' : '';
    const topic = (r.title || '').trim();
    const n = new Notification({ title: 'Steward · 干完了 ' + proj, body: topic ? (topic + ' —— 这个窗口的活干完了') : 'claude 这个窗口的活干完了，点开看' });
    n.on('click', () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } });
    n.show();
  } catch {}
}
setInterval(() => {
  const now = Date.now();
  for (const [key, r] of ptys) {
    if (!r.term) continue;
    const screen = serialize(r.term); const s = sig(screen);
    if (r.lastSig !== undefined && s !== r.lastSig) r.lastChange = now;   // 记录"最近一次屏幕变化"时刻(回退用)
    r.lastSig = s;
    const wasConfirm = r.confirm;
    // 待确认 = 屏幕出现菜单(❯ N.)/y-n（稳定，不会闪），或 claude 权限通知钩子(waiting)
    const hookState = readHookState(key);
    if (hookState && hookState.session && !r.sessionId) r.sessionId = hookState.session;   // 新窗口的会话 id 从钩子补齐(供重命名按会话持久化)
    const tail = s.split('\n').slice(-12).join('\n');
    // 屏幕回退信号(仅当钩子未生效时用):不含 ✻ —— claude 用 ✻ 作"已完成消息"的项目符号(如 ✻ Worked for 3m 33s)，会误命中→卡 busy(诊断确认)
    const working = /esc to interrupt|[↑↓]\s*[\d.,]+\s*k?\s*tokens?|Waiting for \d+ background/.test(tail);
    r.confirm = isConfirm(screen) || (hookState && hookState.state === 'waiting');
    if (hookState && (hookState.state === 'doing' || hookState.state === 'idle')) {
      // 钩子已生效(有真状态 doing/idle)→ 完全信它，绝不再叠屏幕(否则 ✻/残留文字会误判)。事件驱动、无时间窗 → 不闪且准
      r.busy = !r.confirm && hookState.state === 'doing';
    } else {
      // 钩子还没触发(pre-write=init)或无数据(老 claude)→ 屏幕启发式 + 6 秒时间窗兜底
      r.busy = !r.confirm && (working || (r.lastChange && now - r.lastChange < 6000));
    }
    // 完成 = 真回合结束(钩子 doing→idle)。开机欢迎屏/重绘引起的"屏幕兜底忙→闲"不算完成，避免刚开的窗口就误亮蓝灯/误弹完成通知
    const hs = hookState && hookState.state;
    if (r.lastHookState === 'doing' && hs === 'idle' && !r.confirm) { r.done = true; r.doneAt = now; notifyDone(r, key); }
    r.lastHookState = hs;
    if (!wasConfirm && r.confirm) notifyConfirm(r, key);   // 刚进入"等确认"→ 通知
  }
}, 1200);

ipcMain.handle('pty-create', ptyCreate);
ipcMain.handle('pty-write', (e, { key, data }) => { const r = ptys.get(key); if (r) try { r.proc.write(data); } catch {} });
ipcMain.handle('pty-resize', (e, { key, cols, rows }) => { const r = ptys.get(key); if (r) { try { r.proc.resize(cols, rows); } catch {} if (r.term) try { r.term.resize(cols, rows); } catch {} } });
ipcMain.handle('pty-kill', (e, { key }) => { const r = ptys.get(key); if (r) { try { r.proc.kill(); } catch {} ptys.delete(key); } });
ipcMain.handle('pty-capture', (e, { key }) => { const r = ptys.get(key); return r ? serialize(r.term) : ''; });
ipcMain.handle('pty-debug', (e, { key }) => { const r = ptys.get(key); if (!r) return ''; const now = Date.now(); const hs = readHookState(key); const head = `busy=${r.busy} confirm=${r.confirm} hook=${hs ? hs.state + '(' + (now - hs.ts) + 'ms)' : '无'} rows=${r.term && r.term.rows} cols=${r.term && r.term.cols} dataAgo=${r.lastDataAt ? (now - r.lastDataAt) + 'ms' : '-'} changeAgo=${r.lastChange ? (now - r.lastChange) + 'ms' : '-'}`; return head + '\n----headless screen----\n' + serialize(r.term); });   // 状态诊断:看主进程实际抓到的屏幕 + 判定 + 钩子态
ipcMain.handle('clipboard-write', (e, { text }) => { try { clipboard.writeText(String(text || '')); return true; } catch { return false; } });   // 原生剪贴板：不受 sandbox/CSP/焦点限制(navigator.clipboard 在 sandbox 下会失效)
ipcMain.handle('clipboard-read', () => { try { return clipboard.readText() || ''; } catch { return ''; } });   // 与 write 对称，供 Ctrl+Shift+V 自处理粘贴
// 代码热更新(#32)：手动检查/应用；只认官方 Release + SHA256 校验 + 壳兼容门 + 写 userData(不碰只读 .app)
ipcMain.handle('code-update-check', async () => {
  try {
    const meta = await (await fetch(UPDATE_BASE + '/version.json', { cache: 'no-store' })).json();
    const shellOk = !meta.requiresShell || cmpVer(app.getVersion(), meta.requiresShell) >= 0;
    return { ok: true, latest: meta.version, current: currentCodeVersion(), hasUpdate: cmpVer(meta.version, currentCodeVersion()) > 0, shellOk };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('code-update-apply', async () => {
  try {
    const meta = await (await fetch(UPDATE_BASE + '/version.json', { cache: 'no-store' })).json();
    if (meta.requiresShell && cmpVer(app.getVersion(), meta.requiresShell) < 0) return { ok: false, error: '壳太旧，这次更新需下载完整安装包' };
    const buf = Buffer.from(await (await fetch(UPDATE_BASE + '/steward-code.tar.gz')).arrayBuffer());
    if (meta.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== meta.sha256) return { ok: false, error: '校验失败(SHA256 不匹配)，已中止' };
    const ud = app.getPath('userData'), tgz = path.join(ud, 'steward-code.tar.gz'), tmp = path.join(ud, 'steward-code-tmp');
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true }); fs.writeFileSync(tgz, buf);
    const r = spawnSync('tar', ['-xzf', tgz, '-C', tmp]); if (r.status !== 0) return { ok: false, error: '解压失败(tar)' };
    const inner = fs.existsSync(path.join(tmp, 'tools')) ? tmp : path.join(tmp, 'steward');
    if (!fs.existsSync(path.join(inner, 'tools', 'server.mjs')) || !fs.existsSync(path.join(inner, 'dashboard', 'index.html'))) return { ok: false, error: '更新包结构异常，已中止' };
    fs.rmSync(CODE_DIR, { recursive: true, force: true }); fs.renameSync(inner, CODE_DIR);
    try { fs.writeFileSync(path.join(CODE_DIR, 'version.json'), JSON.stringify(meta)); } catch {}
    try { fs.rmSync(tgz, { force: true }); fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: true, version: meta.version };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('app-relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('pty-states', () => [...ptys.entries()].map(([key, r]) => ({ key, projectId: r.projectId, busy: !!r.busy, confirm: !!r.confirm, done: !!r.done, doneAt: r.doneAt || 0, title: r.title || '', activity: r.activity || '', sessionId: r.sessionId || '' })));

// ---------- 3) 窗口 + 注入 native-term ----------
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1440, height: 900, title: 'Steward',
    icon: path.join(__dirname, 'build', 'icon.png'),   // win/linux 任务栏图标(mac 用打包的 icns)
    // 显式写死安全选项(防配置漂移)：渲染端拿不到 require，只能经 preload 的 contextBridge —— #26
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.on('closed', () => { mainWin = null; });   // 置空，pty 回调里的守卫即短路，不再往已销毁窗口发数据
  // 导航锁定：禁止离开本地 origin；外链交系统浏览器 —— 防内容把窗口导航到攻击者站点后 preload 继续注入 stewardPty(#26)
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  mainWin.webContents.on('will-navigate', (e, u) => { try { if (new URL(u).origin !== ORIGIN) { e.preventDefault(); } } catch { e.preventDefault(); } });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { try { if (/^https?:/.test(url)) shell.openExternal(url); } catch {} return { action: 'deny' }; });
  mainWin.loadURL(`${ORIGIN}/`);
  mainWin.webContents.on('did-finish-load', () => {
    try {
      const xtermCss = fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
      const xtermJs = fs.readFileSync(require.resolve('@xterm/xterm/lib/xterm.js'), 'utf8');
      const fitJs = fs.readFileSync(require.resolve('@xterm/addon-fit/lib/addon-fit.js'), 'utf8');
      const nativeJs = fs.readFileSync(path.join(__dirname, 'native-term.js'), 'utf8');
      mainWin.webContents.insertCSS(xtermCss);
      const verJs = 'window.STEWARD_VERSION=' + JSON.stringify(app.getVersion()) + ';try{showAppVersion&&showAppVersion()}catch(e){}';
      mainWin.webContents.executeJavaScript(verJs + '\n' + xtermJs + '\n' + fitJs + '\n' + nativeJs).catch(err => console.error('inject', err));
    } catch (err) { console.error('注入 xterm/native-term 失败：', err.message); }
  });
}

function cleanup() { try { serverProc && serverProc.kill(); } catch {} for (const [, r] of ptys) { try { r.proc.kill(); } catch {} } ptys.clear(); }
// node-pty 1.x 预编译包的 spawn-helper 常被 npm 解包丢掉可执行位 → spawn 必 posix_spawn failed。
// 启动时给它补 +x（dev 与打包后都自愈；打包后 node-pty 走 asarUnpack 在真实磁盘上，可 chmod）。
function fixSpawnHelper() {
  const roots = new Set();
  try { roots.add(path.resolve(path.dirname(require.resolve('node-pty')), '..')); } catch {}
  if (app.isPackaged) roots.add(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty'));   // 打包后 node-pty 在 asar.unpacked
  for (const r of [...roots]) if (r.includes(`app.asar${path.sep}`)) roots.add(r.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));   // require.resolve 可能给 asar 路径，换成 unpacked
  let fixed = 0;
  for (const root of roots) {
    const pb = path.join(root, 'prebuilds');
    let dirs = []; try { dirs = fs.readdirSync(pb); } catch { continue; }
    for (const d of dirs) {
      const h = path.join(pb, d, 'spawn-helper');
      try { if (fs.existsSync(h)) { fs.chmodSync(h, 0o755); fixed++; } } catch {}
    }
  }
  console.log('[pty] spawn-helper chmod 数量:', fixed, '| roots:', [...roots].join(' ; '));
}
// 自检：node-pty 能否 spawn 任意进程（隔离"node-pty 没装好" vs "claude 命令问题"）
function ptySelfTest() {
  console.log('[selftest] node-pty 加载:', !!pty, ' headless:', !!HeadlessTerm, ' claude:', CLAUDE, ' shell:', process.env.SHELL);
  if (!pty) return;
  try {
    const p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-lic', 'echo PTY_OK; exit'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: { ...process.env } });
    let buf = '';
    p.onData(d => (buf += d));
    p.onExit(() => console.log('[selftest] pty 退出，收到 PTY_OK =', buf.includes('PTY_OK'), '| 原始尾:', JSON.stringify(buf.slice(-80))));
  } catch (e) { console.error('[selftest] node-pty 连 spawn 都失败：', e && e.message); }
}
app.whenReady().then(() => { fixSpawnHelper(); startServer(); ptySelfTest(); waitServer(createWindow); });
app.on('window-all-closed', () => { cleanup(); app.quit(); });   // 关窗即退出(含 mac)，不再常驻 dock 需强退
app.on('before-quit', cleanup);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
