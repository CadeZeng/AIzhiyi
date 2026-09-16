// 原位覆盖层预加载
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inplaceAPI', {
  onShow: (cb) => ipcRenderer.on('inplace:show', (_e, data) => cb(data)),
  close: () => ipcRenderer.send('inplace:close'),
  copy: () => ipcRenderer.send('inplace:copy'),
  toggle: () => ipcRenderer.send('inplace:toggle'),
  retry: () => ipcRenderer.send('inplace:retry')
});
