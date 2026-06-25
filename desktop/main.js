// Steward 桌面客户端主进程（Electron）
// 职责：① fork 现有 tools/server.mjs（spec/board/todo/feishu 等 API 原样复用）
//      ② 开窗口加载控制台 ③ 用 node-pty 跑 claude（替代 ttyd+tmux，mac/win 原生）
//      ④ 注入 native-term.js：在渲染端用 xterm.js + IPC 覆盖终端逻辑
const { app, BrowserWindow, ipcMain } = require('electron');
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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), STEWARD_NATIVE: '1' },
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
function isConfirm(s) { return /\([yY]\/[nN]\)|\[[yY]\/[nN]\]|↑\/↓ to select|Do you want to (proceed|continue)|是否(继续|确认|要)|确认[?？]|\bProceed\?/m.test(s.split('\n').slice(-22).join('\n')); }

function ptyCreate(e, { key, projectId, cwd, sessionId }) {
  if (!pty) return { ok: false, error: 'node-pty 未安装/未编译，先在 desktop/ 跑 npm install' };
  if (ptys.has(key)) return { ok: true };
  const args = [...EXTRA]; if (sessionId) args.push('--resume', sessionId);
  let proc;
  try {
    proc = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: cwd || os.homedir(), env: { ...process.env, PATH: SHELL_PATH || process.env.PATH } });
  } catch (err) { return { ok: false, error: 'claude 启动失败：' + err.message }; }
  const term = HeadlessTerm ? new HeadlessTerm({ cols: 100, rows: 30, allowProposedApi: true }) : null;
  const rec = { proc, term, lastSig: undefined, busy: false, confirm: false, title: '', activity: '', projectId, cwd };
  ptys.set(key, rec);
  proc.onData(d => { if (term) term.write(d); if (mainWin) mainWin.webContents.send('pty-data', { key, data: d }); });
  proc.onExit(() => { ptys.delete(key); if (mainWin) mainWin.webContents.send('pty-exit', { key }); });
  return { ok: true };
}

// 周期性算忙/闲/确认（渲染端轮询取）
setInterval(() => {
  for (const [, r] of ptys) {
    if (!r.term) continue;
    const screen = serialize(r.term); const s = sig(screen);
    if (r.lastSig !== undefined) { const busy = s !== r.lastSig; if (r.busy && !busy) r.done = true; r.busy = busy; }
    r.lastSig = s;
    r.confirm = !r.busy && isConfirm(screen);
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
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadURL(`http://127.0.0.1:${PORT}/`);
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
app.whenReady().then(() => { startServer(); waitServer(createWindow); });
app.on('window-all-closed', () => { cleanup(); app.quit(); });   // 关窗即退出(含 mac)，不再常驻 dock 需强退
app.on('before-quit', cleanup);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
