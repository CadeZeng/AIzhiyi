// 全局拖动取词遮罩预加载脚本
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickAPI', {
  onState: (cb) => ipcRenderer.on('pick:state', (_e, data) => cb(data))
});
