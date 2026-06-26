// 安全桥：把 node-pty 的能力暴露给渲染端（控制台页面），供 native-term.js 用
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('STEWARD_NATIVE', true);
contextBridge.exposeInMainWorld('stewardPty', {
  create: (opts) => ipcRenderer.invoke('pty-create', opts),
  write: (key, data) => ipcRenderer.invoke('pty-write', { key, data }),
  resize: (key, cols, rows) => ipcRenderer.invoke('pty-resize', { key, cols, rows }),
  kill: (key) => ipcRenderer.invoke('pty-kill', { key }),
  setActive: (key) => ipcRenderer.invoke('pty-set-active', { key }),
  capture: (key) => ipcRenderer.invoke('pty-capture', { key }),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', { text }),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  states: () => ipcRenderer.invoke('pty-states'),
  onData: (cb) => ipcRenderer.on('pty-data', (e, m) => cb(m)),
  onExit: (cb) => ipcRenderer.on('pty-exit', (e, m) => cb(m)),
});
