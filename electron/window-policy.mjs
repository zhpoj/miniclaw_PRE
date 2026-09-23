export function createWindowOptions(preload) {
  return {
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  }
}

export function classifyNavigation(targetUrl, localOrigin) {
  let target
  try {
    target = new URL(targetUrl)
  } catch {
    return 'deny'
  }

  if (target.origin === localOrigin) return 'allow'
  return target.protocol === 'https:' ? 'external' : 'deny'
}
