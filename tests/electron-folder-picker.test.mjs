import { describe, expect, it } from 'vitest'

import { pickDirectory } from '../electron/folder-picker.mjs'

describe('Electron directory picker', () => {
  it('returns the selected directory and opens at the requested path', async () => {
    let receivedOwner
    let receivedOptions
    const owner = { id: 'main-window' }
    const showOpenDialog = async (window, options) => {
      receivedOwner = window
      receivedOptions = options
      return {
        canceled: false,
        filePaths: ['F:\\Projects\\demo'],
      }
    }

    await expect(
      pickDirectory({
        showOpenDialog,
        owner,
        defaultPath: 'F:\\Projects',
      }),
    ).resolves.toBe('F:\\Projects\\demo')
    expect(receivedOwner).toBe(owner)
    expect(receivedOptions).toEqual({
      defaultPath: 'F:\\Projects',
      properties: ['openDirectory'],
    })
  })

  it('returns null when directory selection is canceled', async () => {
    const showOpenDialog = async () => ({ canceled: true, filePaths: [] })

    await expect(
      pickDirectory({ showOpenDialog, owner: {}, defaultPath: '' }),
    ).resolves.toBeNull()
  })
})
