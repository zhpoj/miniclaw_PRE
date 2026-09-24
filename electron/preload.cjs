const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld(
  'miniClawDesktop',
  Object.freeze({
    platform: process.platform,
    selectDirectory: (defaultPath) =>
      ipcRenderer.invoke('desktop:select-directory', defaultPath),
  }),
)
