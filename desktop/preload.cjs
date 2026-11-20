const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['status', 'dependencies', 'config', 'start', 'stop', 'restart', 'setup', 'chooseDirectory', 'chooseCodex', 'chooseCloudflared', 'openWorkspace', 'removeBackground', 'language', 'cleanUninstall']);
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  invoke(action, body) {
    if (!allowed.has(action)) return Promise.reject(new Error('Unsupported desktop action'));
    return ipcRenderer.invoke('desktop:operation', action, body);
  },
}));
