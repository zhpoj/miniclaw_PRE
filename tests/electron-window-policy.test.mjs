import { describe, expect, it } from 'vitest'

import {
  classifyNavigation,
  createWindowOptions,
} from '../electron/window-policy.mjs'

describe('Electron window policy', () => {
  it('keeps renderer privileges isolated', () => {
    expect(createWindowOptions('F:/repo/electron/preload.cjs')).toMatchObject({
      show: false,
      webPreferences: {
        preload: 'F:/repo/electron/preload.cjs',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
  })

  it.each([
    ['http://127.0.0.1:5173/runs', 'allow'],
    ['https://electronjs.org/docs', 'external'],
    ['http://example.com', 'deny'],
    ['file:///C:/Windows/System32/calc.exe', 'deny'],
    ['javascript:alert(1)', 'deny'],
  ])('classifies %s as %s', (url, expected) => {
    expect(classifyNavigation(url, 'http://127.0.0.1:5173')).toBe(expected)
  })
})
