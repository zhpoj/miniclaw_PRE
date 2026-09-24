// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApprovalDecision, ApprovalRecord } from '../lib/api'
import ApprovalCard from './ApprovalCard'

const pending: ApprovalRecord = {
  id: 'approval-1',
  runId: 'run-1',
  turnId: 'turn-1',
  toolName: 'powershell',
  source: 'feishu',
  cwd: 'F:\\project',
  summary: 'npm test',
  details: { command: 'npm test' },
  status: 'pending',
  createdAt: '2026-09-24T01:00:00.000Z',
  expiresAt: '2026-09-24T01:01:00.000Z',
}

afterEach(cleanup)

describe('ApprovalCard', () => {
  it('shows the real operation, project, source, and all decisions', () => {
    render(<ApprovalCard approval={pending} onDecision={vi.fn()} />)

    expect(screen.getByText('AI 准备运行 PowerShell')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText('F:\\project')).toBeInTheDocument()
    expect(screen.getByText('来源：飞书')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '仅允许这一次' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '允许本次任务' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled()
  })

  it.each([
    ['仅允许这一次', 'allow_once'],
    ['允许本次任务', 'allow_turn'],
    ['拒绝', 'deny'],
  ] as const)('submits %s as %s', async (label, decision) => {
    const user = userEvent.setup()
    const onDecision = vi.fn(
      async (_id: string, choice: ApprovalDecision): Promise<ApprovalRecord> => ({
        ...pending,
        status: choice === 'deny' ? 'denied' : 'allowed',
      }),
    )
    render(<ApprovalCard approval={pending} onDecision={onDecision} />)

    await user.click(screen.getByRole('button', { name: label }))

    expect(onDecision).toHaveBeenCalledWith('approval-1', decision)
  })

  it('disables every decision while submitting and recovers after failure', async () => {
    const user = userEvent.setup()
    let rejectDecision: ((error: Error) => void) | undefined
    const onDecision = vi.fn(
      () => new Promise<ApprovalRecord>((_resolve, reject) => {
        rejectDecision = reject
      }),
    )
    render(<ApprovalCard approval={pending} onDecision={onDecision} />)

    await user.click(screen.getByRole('button', { name: '仅允许这一次' }))
    const buttons = screen.getAllByRole('button')
    for (const button of buttons) expect(button).toBeDisabled()

    rejectDecision?.(new Error('提交失败'))
    expect(await screen.findByText('提交失败')).toBeInTheDocument()
    for (const button of buttons) expect(button).toBeEnabled()
  })

  it('renders a terminal status without action buttons', () => {
    render(
      <ApprovalCard
        approval={{ ...pending, status: 'expired' }}
        onDecision={vi.fn()}
      />,
    )

    expect(screen.getByText('确认已超时')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
