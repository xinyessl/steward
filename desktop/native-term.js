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

  window.stewardPty.onData(({ key, data }) => { const t = terms[key]; if (t) t.term.write(data); });
  window.stewardPty.onExit(({ key }) => { const t = terms[key]; if (t) t.term.write('\r\n\x1b[2m[claude 进程已退出]\x1b[0m\r\n'); });

  function mount(key) {
    const el = document.createElement('div'); el.className = 'nterm'; el.dataset.key = key;
    el.style.cssText = 'position:absolute;inset:0;display:none;background:#111';
    host().appendChild(el);
    const term = new XTerm({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo,Consolas,"Courier New",monospace', theme: { background: '#111' }, scrollback: 5000, macOptionClickForcesSelection: true, rightClickSelectsWord: true });   // claude 开鼠标模式时，按住 Option 拖拽仍能选中文字 → 再 Cmd+C/「复制」
    let fit = null; try { if (FitCls) { fit = new FitCls(); term.loadAddon(fit); } } catch (e) {}
    term.open(el);
    // Cmd+C(mac) / Ctrl+Shift+C 有选区时复制(原生剪贴板)；普通 Ctrl+C 仍透传给终端(SIGINT)
    try { term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.key === 'c' || e.key === 'C') && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
        const sel = term.getSelection(); if (sel) { try { window.stewardPty.clipboardWrite(sel); } catch (x) {} return false; }
      }
      return true;
    }); } catch (e) {}
    const doFit = () => { try { fit && fit.fit(); window.stewardPty.resize(key, term.cols, term.rows); } catch (e) {} };
    setTimeout(doFit, 60);
    term.onData(d => window.stewardPty.write(key, d));
    window.addEventListener('resize', doFit);
    // 宿主尺寸一变就重排：覆盖 splitter 拖拽 / 专注切换 / 窗口缩放(不只依赖 window resize) —— #24
    try { new ResizeObserver(() => doFit()).observe(el); } catch (e) {}
    terms[key] = { term, fit, el, doFit };
    return terms[key];
  }

  window.addWindowDom = function (key, _port, label) {
    mount(key);
    windows.push({ key, label }); renderTabs(); activate(windows.length - 1);
  };
  window.newWindow = async function () {
    if (!PROJECT) { toast('请先「新增项目」'); return; }
    const p = PROJECTS.find(x => x.id === PROJECT) || {};
    const key = mkKey();
    const r = await window.stewardPty.create({ key, projectId: PROJECT, cwd: p.path, sessionId: '' });
    if (!r || !r.ok) { toast((r && r.error) || '终端启动失败'); return; }
    addWindowDom(key, 0, '新对话 ' + (windows.length + 1));
  };
  window.openSession = async function (sessionId, label) {
    const hp = document.getElementById('hist-pop'); if (hp) hp.classList.remove('on');
    const p = PROJECTS.find(x => x.id === PROJECT) || {};
    const key = mkKey();
    const r = await window.stewardPty.create({ key, projectId: PROJECT, cwd: p.path, sessionId });
    if (!r || !r.ok) { toast((r && r.error) || '终端启动失败'); return; }
    addWindowDom(key, 0, label || '历史对话');
  };
  window.activate = function (idx) {
    if (idx < 0 || idx >= windows.length) return; activeIdx = idx;
    document.querySelectorAll('#term-host .nterm').forEach(el => { el.style.display = (el.dataset.key === windows[idx].key) ? 'block' : 'none'; });
    try { window.stewardPty.setActive(windows[idx].key); } catch (e) {}   // 上报当前看的 tab → 主进程据此决定要不要弹确认通知
    const t = terms[windows[idx].key]; if (t) setTimeout(() => { t.doFit(); t.term.focus(); }, 30);
    renderTabs();
  };
  window.closeWin = async function (idx) {
    const w = windows[idx]; if (!w) return;
    try { await window.stewardPty.kill(w.key); } catch (e) {}
    const el = document.querySelector('#term-host .nterm[data-key="' + w.key + '"]'); if (el) el.remove();
    delete terms[w.key]; windows.splice(idx, 1);
    if (!windows.length) { activeIdx = -1; renderTabs(); return; }
    activate(Math.min(idx, windows.length - 1));
  };
  window.sendToTerm = async function (text, enter) {
    let w = windows[activeIdx] || windows[0];
    if (!w) { await newWindow(); w = windows[activeIdx] || windows[0]; }
    if (!w) return;
    setTimeout(() => { try { window.stewardPty.write(w.key, String(text) + (enter ? '\r' : '')); } catch (e) {} }, 350);
  };
  window.copyTermScreen = async function () {
    const w = windows[activeIdx] || windows[0]; if (!w) { toast('没有终端窗口'); return; }
    try {
      // 有选区就复制选区，否则抓整屏
      let text = ''; const t = terms[w.key];
      if (t && t.term && t.term.hasSelection && t.term.hasSelection()) text = t.term.getSelection();
      if (!text) text = (await window.stewardPty.capture(w.key) || '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) { toast('没抓到内容'); return; }
      const ok = await window.stewardPty.clipboardWrite(text);   // 走 Electron 原生剪贴板(sandbox 下 navigator.clipboard 会失效)
      toast(ok ? ('已复制 ' + text.split('\n').length + ' 行到剪贴板') : '复制失败');
    } catch (e) { toast('复制失败：' + (e.message || e)); }
  };
  // 原 setInterval 捕获了旧 pollWinStates 引用 → 它会拉 /api/windows(空)覆盖状态。
  // 这里给 dashboard 暴露一个开关函数；并自起一个 native 轮询。
  async function nativePoll() {
    try {
      const arr = await window.stewardPty.states(); const map = {}, attn = {};
      arr.forEach(s => {
        map[s.key] = { busy: s.busy, confirm: s.confirm, title: s.title, activity: s.activity };
        if (s.confirm) attn[s.projectId] = (attn[s.projectId] || 0) + 1;   // 各项目"等确认"窗口数 → 项目角标
      });
      winState = map; winInit = true;
      attnByProject = attn; applyProjBadges();                              // 恢复项目名后的数字标识(native 数据驱动)
      const total = Object.values(attn).reduce((a, b) => a + b, 0);
      document.title = (total ? `(${total}) ` : '') + 'Steward 控制台';      // 浏览器/窗口标题也带 (N)
      renderTabs();
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
  window.loadTerminal = async function () {
    const msg = document.getElementById('term-msg');
    if (!PROJECT) { if (msg) { msg.style.display = 'grid'; msg.innerHTML = '还没有纳管任何项目。点右上角 <b>「新增项目」</b>。'; } return; }
    if (msg) msg.style.display = 'none';
    windows = projWins[PROJECT] || (projWins[PROJECT] = []);            // 取该项目的窗口组（不销毁其它项目的 pty/DOM）
    document.querySelectorAll('#term-host .nterm').forEach(el => { el.style.display = 'none'; });   // 先全隐藏，activate 再显当前项目的
    if (windows.length) { activeIdx = -1; renderTabs(); activate(windows.length - 1); termBuiltFor = PROJECT; return; }   // 已有窗口：恢复显示
    if (_building.has(PROJECT)) return;                                 // 并发已在建首窗 → 跳过，防双开
    _building.add(PROJECT);
    try { activeIdx = -1; renderTabs(); await openLatestOrNew(); }      // 没窗口：恢复最近历史对话/新对话
    finally { _building.delete(PROJECT); }
    termBuiltFor = PROJECT;
  };

  // 注入时机在 dashboard 初始化之后：ttyd 路径已显示"未检测到 ttyd"。这里接管重建。
  ttydReady = true;
  try { if (typeof MODE !== 'undefined') MODE = 'term'; } catch (e) {}
  loadTerminal();
  console.log('[steward] native terminal (node-pty + xterm) 已接管');
})();
