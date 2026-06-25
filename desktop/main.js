// Steward 桌面客户端主进程（Electron）
// 职责：① fork 现有 tools/server.mjs（spec/board/todo/feishu 等 API 原样复用）
//      ② 开窗口加载控制台 ③ 用 node-pty 跑 claude（替代 ttyd+tmux，mac/win 原生）
//      ④ 注入 native-term.js：在渲染端用 xterm.js + IPC 覆盖终端逻辑
const { app, BrowserWindow, ipcMain, Notification, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { fork, spawnSync } = require('node:child_process');

// 开发：desktop 的上级=仓库根；打包后：随 app 一起放进 resources/steward（见 package.json extraResources）
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'steward') : path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'tools', 'server.mjs');
const PORT = process.env.PORT || 5180;   // 桌面端用 5180，避开 web 版的 5178（同时开也不撞）
let serverProc = null, mainWin = null;

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
  const tail = s.split('\n').slice(-25).join('\n');
  // y/n 确认 | 选择菜单(❯ 1. / Enter to select / ↑↓ navigate) | 是否继续/确认 等
  return /\([yY]\/[nN]\)|\[[yY]\/[nN]\]|↑\/↓|to select|to navigate|Do you want to|是否(继续|确认|要)|确认[?？]|\bProceed\?|press \w+ to (confirm|continue)|❯\s*\d+[.\)]|^\s*\d+[.:]\s+(Yes|No|是|否)/m.test(tail);
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
  const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  let proc;
  try {
    const opts = { name: 'xterm-256color', cols: 100, rows: 30, cwd: cwd || os.homedir(), env: { ...process.env, PATH: SHELL_PATH || process.env.PATH } };
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
  const rec = { proc, term, lastSig: undefined, busy: false, confirm: false, title: '', activity: '', projectId, cwd };
  ptys.set(key, rec);
  const sendWin = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) { try { mainWin.webContents.send(ch, payload); } catch {} } };   // 窗口可能已销毁(关闭时 pty 还在吐数据)→ 守卫，否则 Object has been destroyed
  proc.onData(d => { if (term) { try { term.write(d); } catch {} } sendWin('pty-data', { key, data: d }); });
  proc.onExit(() => { ptys.delete(key); sendWin('pty-exit', { key }); });
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
setInterval(() => {
  for (const [key, r] of ptys) {
    if (!r.term) continue;
    const screen = serialize(r.term); const s = sig(screen);
    if (r.lastSig !== undefined) { const busy = s !== r.lastSig; if (r.busy && !busy) r.done = true; r.busy = busy; }
    r.lastSig = s;
    const wasConfirm = r.confirm;
    r.confirm = !r.busy && isConfirm(screen);
    if (!wasConfirm && r.confirm) notifyConfirm(r, key);   // 刚进入"等确认"→ 通知
  }
}, 1200);

ipcMain.handle('pty-create', ptyCreate);
ipcMain.handle('pty-write', (e, { key, data }) => { const r = ptys.get(key); if (r) try { r.proc.write(data); } catch {} });
ipcMain.handle('pty-resize', (e, { key, cols, rows }) => { const r = ptys.get(key); if (r) { try { r.proc.resize(cols, rows); } catch {} if (r.term) try { r.term.resize(cols, rows); } catch {} } });
ipcMain.handle('pty-kill', (e, { key }) => { const r = ptys.get(key); if (r) { try { r.proc.kill(); } catch {} ptys.delete(key); } });
ipcMain.handle('pty-capture', (e, { key }) => { const r = ptys.get(key); return r ? serialize(r.term) : ''; });
ipcMain.handle('pty-states', () => [...ptys.entries()].map(([key, r]) => ({ key, projectId: r.projectId, busy: !!r.busy, confirm: !!r.confirm, title: r.title || '', activity: r.activity || '' })));

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
      mainWin.webContents.executeJavaScript(xtermJs + '\n' + fitJs + '\n' + nativeJs).catch(err => console.error('inject', err));
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
