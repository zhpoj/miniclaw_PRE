import type { AgentRunSnapshot } from '../lib/api'

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
}

interface Props {
  runs: AgentRunSnapshot[]
  selectedId: string | null
  busy: boolean
  onSelect: (id: string) => void
  onRefresh: () => void
}

/** Sidebar list fed by `GET /api/agent/runs`. */
export default function RunList({ runs, selectedId, busy, onSelect, onRefresh }: Props) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Runs</h2>
        <button className="btn btn-ghost" type="button" onClick={onRefresh} disabled={busy}>
          刷新
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="muted">暂无 run，先在下方创建一个。</p>
      ) : (
        <ul className="run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className={`run-item${run.id === selectedId ? ' active' : ''}`}
                onClick={() => onSelect(run.id)}
              >
                <span className="run-top">
                  <span className={`status status-${run.status}`} />
                  <code>{shortId(run.id)}</code>
                  {run.streaming ? <span className="tag">streaming</span> : null}
                </span>
                <span className="run-meta">
                  {run.model ? `${run.model.provider}/${run.model.id}` : '默认模型'}
                  {' · '}
                  {run.eventCount} events
                </span>
                <span className="run-meta muted">{formatTime(run.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
