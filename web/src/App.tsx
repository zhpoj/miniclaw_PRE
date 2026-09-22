import { useCallback, useEffect, useRef, useState } from 'react'

import CreateRunForm from './components/CreateRunForm'
import EventFeed from './components/EventFeed'
import PromptComposer from './components/PromptComposer'
import RunDetail from './components/RunDetail'
import RunList from './components/RunList'
import {
  createRun,
  fetchEvents,
  fetchHealth,
  listRuns,
  sendPrompt,
  type AgentEventRecord,
  type AgentRunSnapshot,
  type CreateRunInput,
  type EngineHealth,
  type PromptInput,
} from './lib/api'
import './App.css'

const POLL_INTERVAL_MS = 1500
const MAX_RENDERED_EVENTS = 500

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function App() {
  const [health, setHealth] = useState<EngineHealth | null>(null)
  const [runs, setRuns] = useState<AgentRunSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<AgentRunSnapshot | null>(null)
  const [events, setEvents] = useState<AgentEventRecord[]>([])
  const [autoPoll, setAutoPoll] = useState(true)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cursorRef = useRef(0)

  /** Pull the run list plus any new events for the selected run. */
  const tick = useCallback(async (): Promise<void> => {
    try {
      const listed = await listRuns()
      setRuns(listed.runs)
      setNetworkError(null)

      if (selectedId) {
        const page = await fetchEvents(selectedId, cursorRef.current)
        setSelectedRun(page.run)
        if (page.events.length > 0) {
          cursorRef.current = page.events[page.events.length - 1].seq + 1
          setEvents((prev) => [...prev, ...page.events].slice(-MAX_RENDERED_EVENTS))
        }
      }
    } catch (cause) {
      setNetworkError(toMessage(cause))
    }
  }, [selectedId])

  useEffect(() => {
    // Kick off asynchronously: setState must not run synchronously in an effect body.
    const bootstrap = window.setTimeout(() => {
      void tick()
    }, 0)
    if (!autoPoll) {
      return () => {
        window.clearTimeout(bootstrap)
      }
    }
    const timer = window.setInterval(() => {
      void tick()
    }, POLL_INTERVAL_MS)
    return () => {
      window.clearTimeout(bootstrap)
      window.clearInterval(timer)
    }
  }, [tick, autoPoll])

  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch((cause: unknown) => setNetworkError(toMessage(cause)))
  }, [])

  const selectRun = useCallback((id: string): void => {
    cursorRef.current = 0
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
        selectRun(run.id)
        setRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)])
        setNotice(`run 已创建：${run.id}`)
        await tick()
      } catch (cause) {
        setError(toMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [selectRun, tick],
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
        await tick()
      } catch (cause) {
        setError(toMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [selectedId, tick],
  )

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="brand">MiniAgent Console</h1>
          <p className="muted">runs / prompt / events 三接口控制台</p>
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
              checked={autoPoll}
              onChange={(event) => setAutoPoll(event.target.checked)}
            />
            <span>自动轮询 {POLL_INTERVAL_MS}ms</span>
          </label>
          <button className="btn btn-ghost" type="button" onClick={() => void tick()}>
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
            onRefresh={() => void tick()}
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
