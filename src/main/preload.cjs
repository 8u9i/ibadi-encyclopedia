// Exposes a minimal, explicit API to the renderer. No Node.js objects cross the bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ibadi', {
  db: (method, ...args) => ipcRenderer.invoke('db', method, args),
  settings: {
    all: () => ipcRenderer.invoke('settings:all'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  },
  library: {
    status: () => ipcRenderer.invoke('library:status'),
    choose: () => ipcRenderer.invoke('library:choose'),
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openPdf: (url, title) => ipcRenderer.invoke('pdf:open', url, title),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onMenu: (fn) => {
    const listener = (_e, action, arg) => fn(action, arg);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
