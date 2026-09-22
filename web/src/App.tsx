import { useCallback, useEffect, useRef, useState } from 'react'

import CreateRunForm from './components/CreateRunForm'
import EventFeed from './components/EventFeed'
import PromptComposer from './components/PromptComposer'
import RunDetail from './components/RunDetail'
import RunList from './components/RunList'
import {
  createRun,
  fetchHealth,
  fetchRun,
  listRuns,
  sendPrompt,
  subscribeRun,
  type AgentEventRecord,
  type AgentRunSnapshot,
  type CreateRunInput,
  type EngineHealth,
  type PromptInput,
} from './lib/api'
import './App.css'

/** How many events we keep in the DOM before dropping the oldest. */
const MAX_RENDERED_EVENTS = 500
/** Low-frequency refresh for run status / sidebar list (events use SSE instead). */
const META_REFRESH_MS = 2000

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function App() {
  const [health, setHealth] = useState<EngineHealth | null>(null)
  const [runs, setRuns] = useState<AgentRunSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<AgentRunSnapshot | null>(null)
  const [events, setEvents] = useState<AgentEventRecord[]>([])
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const cursorRef = useRef(0)
  const lastSeqRef = useRef(-1)

  /** Low-frequency metadata refresh: sidebar list + selected run status card. */
  const refreshMeta = useCallback(async (): Promise<void> => {
    try {
      const listed = await listRuns()
      setRuns(listed.runs)
      setNetworkError(null)
      if (selectedId) {
        const run = await fetchRun(selectedId)
        setSelectedRun(run)
      }
    } catch (cause) {
      setNetworkError(toMessage(cause))
    }
  }, [selectedId])

  // SSE event stream for the selected run (real-time "streaming" output).
  useEffect(() => {
    if (!selectedId) return
    cursorRef.current = 0
    lastSeqRef.current = -1
    const stop = subscribeRun(selectedId, 0, {
      onRun: (run) => setSelectedRun(run),
      onEvent: (event) => {
        if (event.seq <= lastSeqRef.current) return
        lastSeqRef.current = event.seq
        cursorRef.current = event.seq + 1
        setEvents((prev) => [...prev, event].slice(-MAX_RENDERED_EVENTS))
      },
      onError: (cause) => setNetworkError(toMessage(cause)),
    })
    return () => stop()
  }, [selectedId, refreshKey])

  // Metadata refresh loop (status card + sidebar). Independent of the SSE stream.
  useEffect(() => {
    const bootstrap = window.setTimeout(() => {
      void refreshMeta()
    }, 0)
    if (!autoRefresh) {
      return () => {
        window.clearTimeout(bootstrap)
      }
    }
    const timer = window.setInterval(() => {
      void refreshMeta()
    }, META_REFRESH_MS)
    return () => {
      window.clearTimeout(bootstrap)
      window.clearInterval(timer)
    }
  }, [refreshMeta, autoRefresh, refreshKey])

  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch((cause: unknown) => setNetworkError(toMessage(cause)))
  }, [])

  const selectRun = useCallback((id: string): void => {
    setSelectedId(id)
    setSelectedRun(null)
    setEvents([])
    setNotice(`已切换到 run ${id}`)
  }, [])

  const handleCreate = useCallback(
    async (input: CreateRunInput): Promise<void> => {
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const run = await createRun(input)
        setRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)])
        selectRun(run.id)
        setNotice(`run 已创建：${run.id}`)
      } catch (cause) {
        setError(toMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [selectRun],
  )

  const handlePrompt = useCallback(
    async (text: string, streamingBehavior?: PromptInput['streamingBehavior']): Promise<void> => {
      if (!selectedId) return
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const result = await sendPrompt(selectedId, { text, streamingBehavior })
        setNotice(
          result.mode === 'started'
            ? 'prompt 已接收，agent 开始运行'
            : 'agent 忙碌中，prompt 已按所选行为排入队列',
        )
      } catch (cause) {
        setError(toMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [selectedId],
  )

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="brand">MiniAgent Console</h1>
          <p className="muted">runs / prompt / events · SSE 实时事件</p>
        </div>
        <div className="header-meta">
          {health ? (
            <>
              <span className="chip">
                {health.engine.engine}@{health.engine.version}
              </span>
              <span className="chip">mode: {health.engine.mode}</span>
              <span className="chip">
                runs: {health.engine.activeRuns}/{health.engine.totalRuns}
              </span>
            </>
          ) : (
            <span className="chip">后端未连接</span>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span>自动刷新状态 {META_REFRESH_MS}ms</span>
          </label>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            刷新
          </button>
        </div>
      </header>

      {networkError ? <div className="banner banner-error">服务异常：{networkError}</div> : null}
      {error ? <div className="banner banner-error">{error}</div> : null}
      {notice ? <div className="banner banner-notice">{notice}</div> : null}

      <main className="app-main">
        <aside className="sidebar">
          <RunList
            runs={runs}
            selectedId={selectedId}
            busy={busy}
            onSelect={selectRun}
            onRefresh={() => setRefreshKey((value) => value + 1)}
          />
          <CreateRunForm busy={busy} defaultCwd={health?.engine.cwd} onCreate={handleCreate} />
        </aside>

        <section className="content">
          {selectedRun ? (
            <RunDetail run={selectedRun} />
          ) : (
            <div className="panel">
              <p className="muted">选择左侧 run 或新建一个，即可查看快照并发送 prompt。</p>
            </div>
          )}
          <PromptComposer runId={selectedId} busy={busy} onSend={handlePrompt} />
          <EventFeed events={events} hasRun={Boolean(selectedId)} />
        </section>
      </main>
    </div>
  )
}

