// 浮动结果窗预加载脚本
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resultAPI', {
  onShow: (cb) => ipcRenderer.on('result:show', (_e, data) => cb(data)),
  copyText: (text) => ipcRenderer.send('result:copy', text),
  close: () => ipcRenderer.send('result:close')
});
