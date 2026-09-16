// 截图选区遮罩预加载脚本
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  submit: (rect) => ipcRenderer.invoke('screenshot:select', rect),
  cancel: () => ipcRenderer.send('screenshot:cancel'),
  onInit: (cb) => ipcRenderer.on('overlay:init', (_e, data) => cb(data))
});
