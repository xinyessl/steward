// 仅在 Electron 客户端注入：用 xterm.js + node-pty(经 window.stewardPty) 覆盖终端逻辑。
// web 版不会加载本文件，原 ttyd 路径不受影响。
// 设计：覆盖 window 上的终端函数(它们是函数声明=全局可覆盖)，复用 dashboard 的 windows/winState/renderTabs 等。
(function () {
  if (!window.STEWARD_NATIVE || !window.stewardPty) return;
  const XTerm = window.Terminal;                                   // @xterm/xterm UMD → window.Terminal
  const FitCls = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
  if (!XTerm) { console.error('xterm 未注入'); return; }
  const host = () => document.getElementById('term-host');
  const terms = {};            // key -> {term, fit, el, doFit}
  const projWins = {};         // projectId -> [{key,label}]：每个项目各自一组窗口，切换不丢
  let seq = 0;
  const mkKey = () => 'n' + Date.now().toString(36) + (seq++);
  // 持久化"每个项目开着哪些对话窗口"(key/引擎/会话id/名字) → 强杀/重启后 re-attach 恢复，不丢历史。
  const SW_KEY = 'steward-native-wins';
  function loadSaved() { try { return JSON.parse(localStorage.getItem(SW_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveWins() { try { const o = {}; for (const pid in projWins) { const arr = projWins[pid] || []; if (arr.length) o[pid] = arr.map(w => ({ key: w.key, label: w.label || '', userLabel: w.userLabel || '', engine: w.engine || 'claude', sessionId: w.sessionId || '' })); } localStorage.setItem(SW_KEY, JSON.stringify(o)); } catch (e) {} }

  window.stewardPty.onData(({ key, data }) => { const t = terms[key]; if (t) t.term.write(data); });
  window.stewardPty.onExit(({ key }) => { const t = terms[key]; if (t) t.term.write('\r\n\x1b[2m[进程已退出]\x1b[0m\r\n'); });

  function mount(key) {
    const el = document.createElement('div'); el.className = 'nterm'; el.dataset.key = key;
    el.style.cssText = 'position:absolute;inset:0;display:none;background:#111';
    host().appendChild(el);
    const term = new XTerm({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo,Consolas,"Courier New",monospace', theme: { background: '#111' }, scrollback: 5000, macOptionClickForcesSelection: true, rightClickSelectsWord: true });   // claude 开鼠标模式时，按住 Option 拖拽仍能选中文字 → 再 Cmd+C/「复制」
    let fit = null; try { if (FitCls) { fit = new FitCls(); term.loadAddon(fit); } } catch (e) {}
    term.open(el);
    // 拖文件进终端 → 把绝对路径(shell 转义)写到光标处，像原生终端。Electron31 file.path 已移除，走 preload 暴露的 webUtils。
    el.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {} }, true);
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      let files = []; try { files = [...(e.dataTransfer.files || [])]; } catch (x) {}
      const paths = files.map(f => { try { return (window.stewardPty.getFilePath && window.stewardPty.getFilePath(f)) || ''; } catch (_) { return ''; } }).filter(Boolean);
      if (!paths.length) return;
      const esc = p => /[^\w@%+=:,./~-]/.test(p) ? "'" + p.replace(/'/g, "'\\''") + "'" : p;   // 有空格/特殊字符 → 单引号包，shell 安全
      try { window.stewardPty.write(key, paths.map(esc).join(' ') + ' '); } catch (x) {}   // 末尾加空格，方便接着打
    }, true);
    // Cmd+C(mac) / Ctrl+Shift+C 有选区时复制(原生剪贴板)；普通 Ctrl+C 仍透传给终端(SIGINT)
    try { term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.key === 'c' || e.key === 'C') && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
        const sel = term.getSelection(); if (sel) { try { window.stewardPty.clipboardWrite(sel); } catch (x) {} return false; }
      }
      // 粘贴：Ctrl+Shift+V(终端惯例，与复制对称)→ 读原生剪贴板 → paste，不依赖默认菜单。⌘V/Ctrl+V 仍走系统默认菜单(避免双重粘贴)
      if (e.type === 'keydown' && (e.key === 'v' || e.key === 'V') && e.ctrlKey && e.shiftKey) {
        try { window.stewardPty.clipboardRead && window.stewardPty.clipboardRead().then(txt => { if (txt) term.paste(txt); }); } catch (x) {}
        return false;
      }
      return true;
    }); } catch (e) {}
    // OSC 52：claude(及很多 CLI)发这个转义序列让终端写剪贴板。xterm 默认不处理 → 所以"copied"了却粘不出。这里接管，解码后写原生剪贴板。
    try { term.parser.registerOscHandler(52, (data) => {
      try {
        const i = data.indexOf(';'); const b64 = i >= 0 ? data.slice(i + 1) : data;
        if (b64 && b64 !== '?') { let txt = ''; try { txt = decodeURIComponent(escape(atob(b64))); } catch (x) { try { txt = atob(b64); } catch (y) { txt = ''; } } if (txt) writeClip(txt); }
      } catch (e) {}
      return true;
    }); } catch (e) {}
    // 双保险：选中文字即写入原生剪贴板(不依赖 OSC52/claude)。120ms 防抖。
    let _selTimer = null;
    try { term.onSelectionChange(() => { const s = term.getSelection(); if (!s) return; clearTimeout(_selTimer); _selTimer = setTimeout(() => { try { writeClip(s); } catch (e) {} }, 120); }); } catch (e) {}
    const doFit = () => { try { fit && fit.fit(); window.stewardPty.resize(key, term.cols, term.rows); } catch (e) {} };
    setTimeout(doFit, 60);
    term.onData(d => window.stewardPty.write(key, d));
    window.addEventListener('resize', doFit);
    // 宿主尺寸一变就重排：覆盖 splitter 拖拽 / 专注切换 / 窗口缩放(不只依赖 window resize) —— #24
    try { new ResizeObserver(() => doFit()).observe(el); } catch (e) {}
    terms[key] = { term, fit, el, doFit };
    return terms[key];
  }

  window.addWindowDom = function (key, _port, label, engine) {
    mount(key);
    windows.push({ key, label, engine: engine || 'claude' }); renderTabs(); activate(windows.length - 1); saveWins();
  };
  window.newWindow = async function (engine) {
    if (!PROJECT) { toast('请先「新增项目」'); return; }
    if (engine === 'codex' && window.__codexAvailable === false) { toast('未检测到 codex（未安装或损坏）'); return; }
    const p = PROJECTS.find(x => x.id === PROJECT) || {};
    const key = mkKey();
    const r = await window.stewardPty.create({ key, projectId: PROJECT, cwd: p.path, sessionId: '', engine: engine || 'claude' });
    if (!r || !r.ok) { toast((r && r.error) || '终端启动失败'); return; }
    const base = engine === 'cmd' ? '命令行' : '新对话';
    addWindowDom(key, 0, base + ' ' + (windows.length + 1), r.engine || engine || 'claude');
  };
  const _opening = new Set();   // 正在开的 sessionId，防并发把同一会话开两次
  window.openSession = async function (sessionId, label, engine) {
    const hp = document.getElementById('hist-pop'); if (hp) hp.classList.remove('on');
    if (sessionId) {
      const ex = windows.findIndex(w => w.sessionId === sessionId);
      if (ex >= 0) { activate(ex); return; }       // 该会话已开 → 切过去，不重复开
      if (_opening.has(sessionId)) return;          // 正在开同一会话 → 跳过(防启动双开)
      _opening.add(sessionId);
    }
    try {
      const p = PROJECTS.find(x => x.id === PROJECT) || {};
      const key = mkKey();
      const r = await window.stewardPty.create({ key, projectId: PROJECT, cwd: p.path, sessionId, engine: engine || 'claude' });
      if (!r || !r.ok) { toast((r && r.error) || '终端启动失败'); return; }
      addWindowDom(key, 0, label || '历史对话', r.engine || engine || 'claude');
      if (windows.length) windows[windows.length - 1].sessionId = sessionId;   // 记录会话 id，供去重
    } finally { if (sessionId) _opening.delete(sessionId); }
  };
  window.activate = function (idx) {
    if (idx < 0 || idx >= windows.length) return; activeIdx = idx;
    document.querySelectorAll('#term-host .nterm').forEach(el => { el.style.display = (el.dataset.key === windows[idx].key) ? 'block' : 'none'; });
    try { window.stewardPty.setActive(windows[idx].key); } catch (e) {}   // 上报当前看的 tab → 主进程据此决定要不要弹确认通知
    const t = terms[windows[idx].key]; if (t) setTimeout(() => { t.doFit(); if (!(window.isRenamingTab && window.isRenamingTab())) t.term.focus(); }, 30);   // 重命名编辑中不抢焦点
    document.querySelectorAll('#term-tabs .ttab').forEach((el, i) => el.classList.toggle('on', i === activeIdx));   // 只切高亮，不重建 tab DOM(重建会让双击重命名的元素被换掉→双击失效)；标签/状态点由 1.5s 轮询的 renderTabs 刷新
  };
  window.closeWin = async function (idx) {
    const w = windows[idx]; if (!w) return;
    try { await window.stewardPty.kill(w.key); } catch (e) {}
    const el = document.querySelector('#term-host .nterm[data-key="' + w.key + '"]'); if (el) el.remove();
    delete terms[w.key]; windows.splice(idx, 1); saveWins();
    if (!windows.length) { activeIdx = -1; renderTabs(); return; }
    renderTabs(); activate(Math.min(idx, windows.length - 1));   // activate 不再重建 DOM，关窗后需自己 renderTabs 去掉已关 tab
  };
  window.sendToTerm = async function (text, enter) {
    let w = windows[activeIdx] || windows[0];
    if (!w) { await newWindow(); w = windows[activeIdx] || windows[0]; }
    if (!w) return;
    setTimeout(() => { try { window.stewardPty.write(w.key, String(text) + (enter ? '\r' : '')); } catch (e) {} }, 350);
  };
  function readTermScreen(term) {   // 直接读渲染端 xterm 缓冲区(含滚动历史)——不依赖主进程 headless
    try {
      const b = term.buffer.active, out = [];
      for (let y = 0; y < b.length; y++) { const ln = b.getLine(y); out.push(ln ? ln.translateToString(true) : ''); }
      return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    } catch (e) { return ''; }
  }
  async function writeClip(text) {   // 优先 Electron 原生剪贴板，退回网页剪贴板
    try { if (window.stewardPty && window.stewardPty.clipboardWrite) return await window.stewardPty.clipboardWrite(text); } catch (e) {}
    try { return await copyText(text); } catch (e) { return false; }
  }
  window.copyTermScreen = async function () {
    const w = windows[activeIdx] || windows[0]; if (!w) { toast('没有终端窗口'); return; }
    const t = terms[w.key];
    try {
      let text = '', src = '';
      if (t && t.term && t.term.hasSelection && t.term.hasSelection()) { text = t.term.getSelection(); src = '选区'; }
      if (!text && t && t.term) { text = readTermScreen(t.term); src = '整屏'; }            // 渲染端读 buffer(最稳)
      if (!text) { text = (await window.stewardPty.capture(w.key) || '').trim(); src = '整屏·兜底'; }  // headless 兜底
      if (!text) { toast('没抓到内容(选区空、缓冲也空)'); return; }
      const ok = await writeClip(text);
      toast(ok ? ('已复制 ' + src + ' ' + text.split('\n').length + ' 行') : '写剪贴板失败(clipboardWrite=false)');
    } catch (e) { toast('复制异常：' + (e && e.message || e)); }
  };
  // 原 setInterval 捕获了旧 pollWinStates 引用 → 它会拉 /api/windows(空)覆盖状态。
  // 这里给 dashboard 暴露一个开关函数；并自起一个 native 轮询。
  async function nativePoll() {
    try {
      const arr = await window.stewardPty.states(); const map = {}, attn = {}, busyP = {}, doneP = {}; const NOW = Date.now();
      arr.forEach(s => {
        map[s.key] = { busy: s.busy, confirm: s.confirm, done: s.done, title: s.title, activity: s.activity };
        if (s.sessionId) { const w = windows.find(x => x.key === s.key); if (w && !w.sessionId) w.sessionId = s.sessionId; }   // 新窗口会话 id 从钩子回填 → 重命名可按会话持久化
        if (s.confirm) attn[s.projectId] = (attn[s.projectId] || 0) + 1;                                 // 待确认
        else if (s.busy) busyP[s.projectId] = (busyP[s.projectId] || 0) + 1;                             // 干活中
        if (s.done && s.doneAt && NOW - s.doneAt < 120000 && s.projectId !== PROJECT) doneP[s.projectId] = (doneP[s.projectId] || 0) + 1;   // 刚完成(120s 内·非当前项目)
      });
      winState = map; winInit = true;
      attnByProject = attn; busyByProject = busyP; doneByProject = doneP; applyProjBadges();             // 项目栏多状态角标(native 数据驱动)
      const total = Object.values(attn).reduce((a, b) => a + b, 0);
      document.title = (total ? `(${total}) ` : '') + 'Steward 控制台';      // 浏览器/窗口标题也带 (N)
      renderTabs(); saveWins();   // 顺带把回填的会话 id / 重命名持久化，供重启恢复
    } catch (e) {}
  }
  window.pollWinStates = nativePoll;                 // 后续若有按 window 调用的，走 native
  setInterval(nativePoll, 1500);                      // 自起轮询(原 interval 捕获的旧引用无害：/api/windows 返回空，但会被本轮询覆盖)

  const _building = new Set();   // 防并发重复建首窗(startup 多处调 loadTerminal 会双开)
  async function openLatestOrNew() {   // 没窗口时：恢复该项目最近一次历史对话，没有则开新对话
    try {
      const p = PROJECTS.find(x => x.id === PROJECT) || {};
      const r = await (await fetch('/api/claude-sessions?path=' + encodeURIComponent(p.path || '') + '&t=' + Date.now())).json();
      const ss = (r.sessions || []).slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      if (ss.length) { await openSession(ss[0].id, (ss[0].preview || '历史对话').slice(0, 14)); return; }
    } catch (e) {}
    await newWindow();
  }
  async function restoreOrOpen() {   // 重启恢复：先把上次开着的对话 re-attach 回来(tmux 存活的原样回来、死了的按 sessionId resume)，都没有才开新的
    const saved = (loadSaved()[PROJECT] || []);
    let n = 0;
    for (const sw of saved) {
      try {
        let alive = false; try { alive = await window.stewardPty.tmuxAlive(sw.key); } catch (e) {}
        if (!alive && !sw.sessionId) continue;   // tmux 会话没了、又没会话 id → 是个没用过的空窗口，别复活
        const p = PROJECTS.find(x => x.id === PROJECT) || {};
        const r = await window.stewardPty.create({ key: sw.key, projectId: PROJECT, cwd: p.path, sessionId: sw.sessionId || '', engine: sw.engine || 'claude' });
        if (!r || !r.ok) continue;
        addWindowDom(sw.key, 0, sw.userLabel || sw.label || '恢复的对话', r.engine || sw.engine || 'claude');
        const w = windows[windows.length - 1]; if (w) { w.sessionId = sw.sessionId || ''; if (sw.userLabel) w.userLabel = sw.userLabel; }
        n++;
      } catch (e) {}
    }
    if (n) { activate(windows.length - 1); return; }
    await openLatestOrNew();
  }
  window.loadTerminal = async function () {
    const msg = document.getElementById('term-msg');
    if (!PROJECT) { if (msg) { msg.style.display = 'grid'; msg.innerHTML = '还没有纳管任何项目。点右上角 <b>「新增项目」</b>。'; } return; }
    if (msg) msg.style.display = 'none';
    windows = projWins[PROJECT] || (projWins[PROJECT] = []);            // 取该项目的窗口组（不销毁其它项目的 pty/DOM）
    document.querySelectorAll('#term-host .nterm').forEach(el => { el.style.display = 'none'; });   // 先全隐藏，activate 再显当前项目的
    if (windows.length) { activeIdx = -1; renderTabs(); activate(windows.length - 1); termBuiltFor = PROJECT; return; }   // 已有窗口：恢复显示
    if (_building.has(PROJECT)) return;                                 // 并发已在建首窗 → 跳过，防双开
    _building.add(PROJECT);
    try { activeIdx = -1; renderTabs(); await restoreOrOpen(); }      // 没窗口：先 re-attach 上次开着的对话，没有再恢复最近/开新
    finally { _building.delete(PROJECT); }
    termBuiltFor = PROJECT;
  };

  // 注入时机在 dashboard 初始化之后：ttyd 路径已显示"未检测到 ttyd"。这里接管重建。
  ttydReady = true;
  try { if (typeof MODE !== 'undefined') MODE = 'term'; } catch (e) {}
  loadTerminal();
  console.log('[steward] native terminal (node-pty + xterm) 已接管');
})();
