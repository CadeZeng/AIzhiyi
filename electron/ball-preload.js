// ============================================================
// AI智译 · LOGO 小球预加载脚本
// 在小球窗口中安全暴露 IPC API
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ballAPI', {
  // 接收主进程推送的开关状态
  onState: (callback) => {
    const handler = (_e, v) => callback(v);
    ipcRenderer.on('ball:state', handler);
    return () => ipcRenderer.removeListener('ball:state', handler);
  },
  // 点击切换开关
  toggle: () => ipcRenderer.send('ball:toggle'),
  // 拖动移动
  dragMove: () => ipcRenderer.send('ball:drag-move'),
  dragEnd: () => ipcRenderer.send('ball:drag-end')
});
