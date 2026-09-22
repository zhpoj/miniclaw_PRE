import type { AgentRunSnapshot } from '../lib/api'

interface Props {
  run: AgentRunSnapshot
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  )
}

/** Header card showing the latest snapshot of the selected run. */
export default function RunDetail({ run }: Props) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          <span className={`status status-${run.status}`} /> {run.id}
        </h2>
        <span className="tag">{run.status}</span>
      </div>

      <div className="kv-grid">
        <Row label="model" value={run.model ? `${run.model.provider}/${run.model.id}` : '-'} />
        <Row label="thinking" value={run.thinkingLevel ?? '-'} />
        <Row label="cwd" value={run.cwd} />
        <Row label="tools" value={run.tools.join(', ') || '-'} />
        <Row label="events" value={String(run.eventCount)} />
        <Row label="session" value={run.piSessionId ?? '-'} />
      </div>

      {run.lastError ? <div className="banner banner-error">lastError: {run.lastError}</div> : null}
    </div>
  )
}
