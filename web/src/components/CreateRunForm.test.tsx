// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import CreateRunForm from './CreateRunForm'

type DesktopApi = {
  platform: string
  selectDirectory(defaultPath?: string): Promise<string | null>
}

function setDesktopApi(api?: DesktopApi) {
  Object.defineProperty(window, 'miniClawDesktop', {
    configurable: true,
    value: api,
  })
}

afterEach(() => {
  cleanup()
  setDesktopApi(undefined)
})

describe('CreateRunForm directory picker', () => {
  it('fills cwd with the directory selected from Electron', async () => {
    const user = userEvent.setup()
    setDesktopApi({
      platform: 'win32',
      selectDirectory: async () => 'F:\\Projects\\demo',
    })

    render(
      <CreateRunForm
        busy={false}
        defaultCwd="F:\\Projects"
        onCreate={async () => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: '选择文件夹' }))

    expect((screen.getByLabelText('cwd') as HTMLInputElement).value).toBe(
      'F:\\Projects\\demo',
    )
  })

  it('keeps cwd unchanged when directory selection is canceled', async () => {
    const user = userEvent.setup()
    setDesktopApi({
      platform: 'win32',
      selectDirectory: async () => null,
    })

    render(
      <CreateRunForm
        busy={false}
        defaultCwd="F:\\Projects"
        onCreate={async () => {}}
      />,
    )
    const cwd = screen.getByLabelText('cwd')
    await user.type(cwd, 'F:\\Existing')

    await user.click(screen.getByRole('button', { name: '选择文件夹' }))

    expect((cwd as HTMLInputElement).value).toBe('F:\\Existing')
  })
})
