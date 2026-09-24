import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef } from 'react'

import type {
  AgentEventRecord,
  ApprovalDecision,
  ApprovalRecord,
} from '../lib/api'
import { buildConversation } from '../lib/conversation'
import ApprovalCard from './ApprovalCard'

interface Props {
  events: AgentEventRecord[]
  approvals: ApprovalRecord[]
  hasRun: boolean
  onApprovalDecision: (
    id: string,
    decision: ApprovalDecision,
  ) => Promise<ApprovalRecord>
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function ChatTimeline({
  events,
  approvals,
  hasRun,
  onApprovalDecision,
}: Props) {
  const items = useMemo(
    () => buildConversation(events, approvals),
    [approvals, events],
  )
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [items])

  if (!hasRun) {
    return (
      <div className="chat-empty">
        <h1>从当前项目开始</h1>
        <p>新建一个会话，然后告诉 MiniClaw 你想理解、修改或完成什么。</p>
      </div>
    )
  }

  return (
    <div className="chat-timeline" aria-live="polite">
      {items.length === 0 ? (
        <div className="chat-empty compact">
          <h2>这是一个新会话</h2>
          <p>在下方输入你的第一个问题。</p>
        </div>
      ) : (
        items.map((item) => {
          if (item.kind === 'activity') {
            const Icon =
              item.status === 'running'
                ? CircleNotch
                : item.status === 'error'
                  ? WarningCircle
                  : CheckCircle
            return (
              <div className={`activity-row ${item.status}`} key={item.id}>
                <Icon
                  size={17}
                  weight="fill"
                  className={item.status === 'running' ? 'activity-spinner' : ''}
                  aria-hidden="true"
                />
                <span>{item.label}</span>
                <time>{formatTime(item.at)}</time>
              </div>
            )
          }

          if (item.kind === 'approval') {
            return (
              <ApprovalCard
                key={item.id}
                approval={item.approval}
                onDecision={onApprovalDecision}
              />
            )
          }

          return (
            <article className={`chat-message ${item.role}`} key={item.id}>
              <div className="message-copy">{item.text}</div>
              <time>{formatTime(item.at)}</time>
            </article>
          )
        })
      )}
      <div ref={endRef} />
    </div>
  )
}
