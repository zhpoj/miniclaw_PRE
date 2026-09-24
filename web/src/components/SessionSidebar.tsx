import { ChatCircleDots, Plus } from '@phosphor-icons/react'

import type { AgentRunSnapshot } from '../lib/api'

interface Props {
  runs: AgentRunSnapshot[]
  selectedId: string | null
  busy: boolean
  titles: Record<string, string>
  onSelect: (id: string) => void
  onNew: () => void
}

function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function SessionSidebar({
  runs,
  selectedId,
  busy,
  titles,
  onSelect,
  onNew,
}: Props) {
  return (
    <aside className="session-sidebar" aria-label="历史会话">
      <div className="sidebar-brand">
        <ChatCircleDots size={24} weight="fill" aria-hidden="true" />
        <span>MiniClaw</span>
      </div>

      <button
        className="new-session-button"
        type="button"
        disabled={busy}
        onClick={onNew}
      >
        <Plus size={18} weight="bold" aria-hidden="true" />
        新建会话
      </button>

      <div className="session-heading">会话</div>
      <nav className="session-list">
        {runs.length === 0 ? (
          <p className="session-empty">还没有会话，点击上方按钮开始。</p>
        ) : (
          runs.map((run) => {
            const title = titles[run.id] ?? `新会话 ${run.id.slice(0, 5)}`
            return (
              <button
                className={`session-item${run.id === selectedId ? ' active' : ''}`}
                type="button"
                key={run.id}
                aria-current={run.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(run.id)}
              >
                <span className={`session-status status-${run.status}`} />
                <span className="session-copy">
                  <strong>{title}</strong>
                  <span>{projectName(run.cwd)}</span>
                </span>
                <time>{formatTime(run.createdAt)}</time>
              </button>
            )
          })
        )}
      </nav>
    </aside>
  )
}
