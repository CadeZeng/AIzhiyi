// 浮动结果窗预加载脚本
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resultAPI', {
  onShow: (cb) => ipcRenderer.on('result:show', (_e, data) => cb(data)),
  onPinned: (cb) => ipcRenderer.on('result:pinned', (_e, v) => cb(v)),
  copyText: (text) => ipcRenderer.send('result:copy', text),
  close: () => ipcRenderer.send('result:close'),
  togglePin: () => ipcRenderer.send('result:pin-toggle')
});
