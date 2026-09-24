export async function pickDirectory({ showOpenDialog, owner, defaultPath }) {
  const options = {
    properties: ['openDirectory'],
  }
  const normalizedDefault =
    typeof defaultPath === 'string' ? defaultPath.trim() : ''
  if (normalizedDefault) options.defaultPath = normalizedDefault

  const result = await showOpenDialog(owner, options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}
