const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld(
  'miniClawDesktop',
  Object.freeze({
    platform: process.platform,
  }),
)
