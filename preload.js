const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  open: kind => ipcRenderer.invoke('open', kind),
  probe: files => ipcRenderer.invoke('probe', files.map(f => webUtils.getPathForFile(f))),
  export: project => ipcRenderer.invoke('export', project),
  thumbs: (file, duration) => ipcRenderer.invoke('thumbs', file, duration),
  saveProject: (file, data) => ipcRenderer.invoke('saveProject', file, data),
  openProject: () => ipcRenderer.invoke('openProject'),
  onProgress: cb => ipcRenderer.on('progress', (_, p) => cb(p)),
  version: () => ipcRenderer.invoke('version'),
  checkUpdates: () => ipcRenderer.invoke('checkUpdates'),
  onEncoder: cb => ipcRenderer.on('encoder', (_, e) => cb(e)),
});
