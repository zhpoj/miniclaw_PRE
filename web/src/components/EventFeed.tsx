import { useEffect, useMemo, useRef, useState } from 'react'

import type { AgentEventRecord } from '../lib/api'

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
}

function stringifyPayload(payload: unknown): string {
  if (payload === undefined) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

interface Props {
  events: AgentEventRecord[]
  hasRun: boolean
}

/** Live log rendered from `GET /api/agent/runs/:id/events` polling. */
export default function EventFeed({ events, hasRun }: Props) {
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!autoScroll) return
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [events, autoScroll])

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return events
    return events.filter(
      (event) =>
        event.type.toLowerCase().includes(query) ||
        stringifyPayload(event.payload).toLowerCase().includes(query),
    )
  }, [events, filter])

  return (
    <div className="panel feed">
      <div className="panel-head">
        <h2>Events</h2>
        <span className="muted">GET /api/agent/runs/:id/events</span>
      </div>

      <div className="feed-controls">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="按类型或内容过滤…"
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          <span>自动滚动</span>
        </label>
        <span className="muted">{visible.length}/{events.length}</span>
      </div>

      <div className="event-list" ref={listRef}>
        {!hasRun ? (
          <p className="muted">未选择 run。</p>
        ) : visible.length === 0 ? (
          <p className="muted">暂无事件。</p>
        ) : (
          visible.map((event) => (
            <article className="event" key={event.seq}>
              <header className="event-head">
                <span className="event-seq">#{event.seq}</span>
                <span className="event-type">{event.type}</span>
                <span className="muted">{formatTime(event.at)}</span>
              </header>
              {stringifyPayload(event.payload) ? (
                <pre className="event-payload">{stringifyPayload(event.payload)}</pre>
              ) : null}
            </article>
          ))
        )}
      </div>
    </div>
  )
}
