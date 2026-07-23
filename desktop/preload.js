// 安全桥：把 node-pty 的能力暴露给渲染端（控制台页面），供 native-term.js 用
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('STEWARD_NATIVE', true);
contextBridge.exposeInMainWorld('stewardPty', {
  create: (opts) => ipcRenderer.invoke('pty-create', opts),
  write: (key, data) => ipcRenderer.invoke('pty-write', { key, data }),
  resize: (key, cols, rows) => ipcRenderer.invoke('pty-resize', { key, cols, rows }),
  kill: (key) => ipcRenderer.invoke('pty-kill', { key }),
  setActive: (key) => ipcRenderer.invoke('pty-set-active', { key }),
  capture: (key) => ipcRenderer.invoke('pty-capture', { key }),
  debug: (key) => ipcRenderer.invoke('pty-debug', { key }),
  getFilePath: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },   // 拖文件进终端取绝对路径(Electron31: file.path 已移除，改用 webUtils)
  tmuxAlive: (key) => ipcRenderer.invoke('pty-tmux-alive', { key }),   // 重启恢复时问：该窗口的 tmux 会话还活着吗
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', { text }),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  checkCodeUpdate: () => ipcRenderer.invoke('code-update-check'),
  applyCodeUpdate: () => ipcRenderer.invoke('code-update-apply'),
  relaunch: () => ipcRenderer.invoke('app-relaunch'),
  states: () => ipcRenderer.invoke('pty-states'),
  onData: (cb) => ipcRenderer.on('pty-data', (e, m) => cb(m)),
  onExit: (cb) => ipcRenderer.on('pty-exit', (e, m) => cb(m)),
});
