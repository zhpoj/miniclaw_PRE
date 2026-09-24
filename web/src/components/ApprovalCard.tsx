import {
  CheckCircle,
  ClockCountdown,
  FileText,
  ShieldWarning,
  TerminalWindow,
  XCircle,
} from '@phosphor-icons/react'
import { useState } from 'react'

import type { ApprovalDecision, ApprovalRecord } from '../lib/api'

interface Props {
  approval: ApprovalRecord
  onDecision: (id: string, decision: ApprovalDecision) => Promise<ApprovalRecord>
}

const statusCopy: Record<Exclude<ApprovalRecord['status'], 'pending'>, string> = {
  allowed: '操作已允许',
  denied: '操作已拒绝',
  expired: '确认已超时',
  cancelled: '操作已取消',
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function ApprovalCard({ approval, onDecision }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<ApprovalRecord | null>(null)
  const current = approval.status !== 'pending'
    ? approval
    : resolved?.id === approval.id
      ? resolved
      : approval
  const isPowerShell = current.toolName === 'powershell'
  const Icon = isPowerShell ? TerminalWindow : FileText

  const submit = async (decision: ApprovalDecision): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      setResolved(await onDecision(current.id, decision))
    } catch (cause) {
      setError(toMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <article className={`approval-card ${current.status}`}>
      <div className="approval-heading">
        <span className="approval-icon" aria-hidden="true">
          <ShieldWarning size={20} weight="fill" />
        </span>
        <div>
          <h3>{isPowerShell ? 'AI 准备运行 PowerShell' : 'AI 准备修改文件'}</h3>
          <p>{current.source === 'feishu' ? '来源：飞书' : '需要你的确认'}</p>
        </div>
      </div>

      <div className="approval-command">
        <Icon size={17} aria-hidden="true" />
        <code>{current.summary}</code>
      </div>
      <div className="approval-cwd">
        <span>当前项目</span>
        <code>{current.cwd}</code>
      </div>

      {current.status === 'pending' ? (
        <>
          <div className="approval-actions">
            <button
              type="button"
              className="approval-button once"
              disabled={submitting}
              onClick={() => void submit('allow_once')}
            >
              仅允许这一次
            </button>
            <button
              type="button"
              className="approval-button turn"
              disabled={submitting}
              onClick={() => void submit('allow_turn')}
            >
              允许本次任务
            </button>
            <button
              type="button"
              className="approval-button deny"
              disabled={submitting}
              onClick={() => void submit('deny')}
            >
              拒绝
            </button>
          </div>
          <p className="approval-help">
            仅当前这轮对话有效，回答结束后自动失效
          </p>
          {error ? <p className="approval-error">{error}</p> : null}
        </>
      ) : (
        <div className={`approval-result ${current.status}`}>
          {current.status === 'allowed' ? (
            <CheckCircle size={18} weight="fill" aria-hidden="true" />
          ) : current.status === 'expired' ? (
            <ClockCountdown size={18} weight="fill" aria-hidden="true" />
          ) : (
            <XCircle size={18} weight="fill" aria-hidden="true" />
          )}
          <span>{statusCopy[current.status]}</span>
        </div>
      )}
    </article>
  )
}
