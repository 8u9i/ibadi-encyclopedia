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
    remote: () => ipcRenderer.invoke('library:remote'),
    download: (chooseFolder) => ipcRenderer.invoke('library:download', !!chooseFolder),
    cancelDownload: () => ipcRenderer.invoke('library:cancelDownload'),
    onDownload: (fn) => {
      const l = (_e, ev) => fn(ev);
      ipcRenderer.on('library-download', l);
      return () => ipcRenderer.removeListener('library-download', l);
    },
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openPdf: (url, title) => ipcRenderer.invoke('pdf:open', url, title),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  appInfo: () => ipcRenderer.invoke('app:info'),
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    run: () => ipcRenderer.invoke('sync:run'),
    setAuto: (on) => ipcRenderer.invoke('sync:auto', on),
    choose: () => ipcRenderer.invoke('sync:choose'),
    onEvent: (fn) => {
      const l = (_e, ev) => fn(ev);
      ipcRenderer.on('sync-event', l);
      return () => ipcRenderer.removeListener('sync-event', l);
    },
    onLibraryChanged: (fn) => {
      const l = (_e, ev) => fn(ev);
      ipcRenderer.on('library-changed', l);
      return () => ipcRenderer.removeListener('library-changed', l);
    },
  },
  window: {
    state: () => ipcRenderer.invoke('window:state'),
    minimize: () => ipcRenderer.invoke('window:control', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:control', 'toggle-maximize'),
    close: () => ipcRenderer.invoke('window:control', 'close'),
    onState: (fn) => {
      const listener = (_e, s) => fn(s);
      ipcRenderer.on('window-state', listener);
      return () => ipcRenderer.removeListener('window-state', listener);
    },
  },
  onMenu: (fn) => {
    const listener = (_e, action, arg) => fn(action, arg);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
