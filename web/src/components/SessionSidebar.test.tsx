// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRunSnapshot } from '../lib/api'
import SessionSidebar from './SessionSidebar'

const run: AgentRunSnapshot = {
  id: 'abcdef12-3456',
  createdAt: '2026-09-24T01:00:00.000Z',
  cwd: 'F:\\Projects\\demo',
  status: 'idle',
  streaming: false,
  tools: ['read', 'edit'],
  eventCount: 4,
  model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
  thinkingLevel: 'high',
  piSessionId: undefined,
  piSessionFile: undefined,
  lastError: undefined,
}

afterEach(cleanup)

describe('SessionSidebar', () => {
  it('supports creating and selecting conversations', async () => {
    const user = userEvent.setup()
    let selected = ''
    let created = false

    const { rerender } = render(
      <SessionSidebar
        runs={[run]}
        selectedId={null}
        busy={false}
        titles={{ [run.id]: '检查登录页面' }}
        onSelect={(id) => {
          selected = id
        }}
        onNew={() => {
          created = true
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: '新建会话' }))
    expect(created).toBe(true)

    await user.click(screen.getByRole('button', { name: /检查登录页面/ }))
    expect(selected).toBe(run.id)

    rerender(
      <SessionSidebar
        runs={[run]}
        selectedId={run.id}
        busy={false}
        titles={{ [run.id]: '检查登录页面' }}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    )
    expect(
      screen.getByRole('button', { name: /检查登录页面/ }).getAttribute('aria-current'),
    ).toBe('true')
  })
})
