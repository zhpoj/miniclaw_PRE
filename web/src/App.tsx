import {
  ArrowClockwise,
  FolderOpen,
  ListBullets,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import ChatTimeline from './components/ChatTimeline'
import EventFeed from './components/EventFeed'
import PromptComposer from './components/PromptComposer'
import RunDetail from './components/RunDetail'
import SessionSidebar from './components/SessionSidebar'
import {
  createRun,
  decideApproval,
  fetchHealth,
  fetchRun,
  heartbeatApprovalClient,
  listPendingApprovals,
  listRuns,
  sendPrompt,
  subscribeRun,
  type AgentEventRecord,
  type AgentRunSnapshot,
  type ApprovalDecision,
  type ApprovalRecord,
  type EngineHealth,
  type PromptInput,
} from './lib/api'
import { buildConversation } from './lib/conversation'
import './App.css'

const MAX_RENDERED_EVENTS = 500
const META_REFRESH_MS = 2000
const APPROVAL_HEARTBEAT_MS = 5000
const APPROVAL_CLIENT_ID = globalThis.crypto.randomUUID()

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized
}

export default function App() {
  const [health, setHealth] = useState<EngineHealth | null>(null)
  const [runs, setRuns] = useState<AgentRunSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<AgentRunSnapshot | null>(null)
  const [events, setEvents] = useState<AgentEventRecord[]>([])
  const [recoveredApprovals, setRecoveredApprovals] = useState<ApprovalRecord[]>([])
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [preferredCwd, setPreferredCwd] = useState('')
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const lastSeqRef = useRef(-1)

  const currentFolder =
    selectedRun?.cwd || preferredCwd || health?.engine.cwd || '正在连接项目…'

  const refreshMeta = useCallback(async (): Promise<void> => {
    try {
      const listed = await listRuns()
      setRuns(listed.runs)
      setNetworkError(null)
      if (!selectedId && listed.runs[0]) {
        setSelectedId(listed.runs[0].id)
        setPreferredCwd(listed.runs[0].cwd)
      } else if (selectedId) {
        const run = await fetchRun(selectedId)
        setSelectedRun(run)
      }
    } catch (cause) {
      setNetworkError(toMessage(cause))
    }
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) return
    let active = true
    lastSeqRef.current = -1
    void listPendingApprovals(selectedId)
      .then(({ approvals }) => {
        if (active) setRecoveredApprovals(approvals)
      })
      .catch((cause: unknown) => {
        if (active) setNetworkError(toMessage(cause))
      })
    const stop = subscribeRun(selectedId, 0, {
      onRun: (run) => {
        setSelectedRun(run)
        setPreferredCwd(run.cwd)
      },
      onEvent: (event) => {
        if (event.seq <= lastSeqRef.current) return
        lastSeqRef.current = event.seq
        setEvents((previous) => [...previous, event].slice(-MAX_RENDERED_EVENTS))
      },
      onError: (cause) => setNetworkError(toMessage(cause)),
    })
    return () => {
      active = false
      stop()
    }
  }, [selectedId, refreshKey])

  useEffect(() => {
    if (!window.miniClawDesktop) return
    const heartbeat = (): void => {
      void heartbeatApprovalClient(APPROVAL_CLIENT_ID).catch((cause: unknown) => {
        setNetworkError(toMessage(cause))
      })
    }
    heartbeat()
    const timer = window.setInterval(heartbeat, APPROVAL_HEARTBEAT_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const bootstrap = window.setTimeout(() => void refreshMeta(), 0)
    const timer = window.setInterval(() => void refreshMeta(), META_REFRESH_MS)
    return () => {
      window.clearTimeout(bootstrap)
      window.clearInterval(timer)
    }
  }, [refreshMeta, refreshKey])

  useEffect(() => {
    void fetchHealth()
      .then((result) => {
        setHealth(result)
        setPreferredCwd((current) => current || result.engine.cwd)
      })
      .catch((cause: unknown) => setNetworkError(toMessage(cause)))
  }, [])

  const conversation = useMemo(() => buildConversation(events), [events])
  const sidebarTitles = useMemo(() => {
    if (!selectedId || titles[selectedId]) return titles
    const firstUserMessage = conversation.find(
      (item) => item.kind === 'message' && item.role === 'user',
    )
    if (firstUserMessage?.kind === 'message') {
      return {
        ...titles,
        [selectedId]: shortTitle(firstUserMessage.text),
      }
    }
    return titles
  }, [conversation, selectedId, titles])

  const selectRun = useCallback(
    (id: string): void => {
      const run = runs.find((item) => item.id === id)
      setSelectedId(id)
      setSelectedRun(run ?? null)
      setEvents([])
      setRecoveredApprovals([])
      if (run) setPreferredCwd(run.cwd)
      setError(null)
      setNotice(null)
    },
    [runs],
  )

  const createConversation = useCallback(
    async (cwd?: string): Promise<void> => {
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const run = await createRun(cwd ? { cwd } : {})
        setRuns((previous) => [
          run,
          ...previous.filter((item) => item.id !== run.id),
        ])
        setTitles((previous) => ({ ...previous, [run.id]: '新会话' }))
        setSelectedId(run.id)
        setSelectedRun(run)
        setPreferredCwd(run.cwd)
        setEvents([])
        setRecoveredApprovals([])
        setNotice('新会话已准备好')
      } catch (cause) {
        setError(toMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const changeFolder = useCallback(async (): Promise<void> => {
    const desktopApi = window.miniClawDesktop
    if (!desktopApi) {
      setError('当前环境不支持文件夹选择，请在 Electron 客户端中使用。')
      return
    }
    try {
      const selected = await desktopApi.selectDirectory(currentFolder)
      if (selected) await createConversation(selected)
    } catch (cause) {
      setError(toMessage(cause))
    }
  }, [createConversation, currentFolder])

  const handlePrompt = useCallback(
    async (
      text: string,
      streamingBehavior?: PromptInput['streamingBehavior'],
    ): Promise<void> => {
      if (!selectedId) return
      setBusy(true)
      setError(null)
      setNotice(null)
      setTitles((previous) => ({
        ...previous,
        [selectedId]: previous[selectedId] === '新会话'
          ? shortTitle(text)
          : (previous[selectedId] ?? shortTitle(text)),
      }))
      try {
        const source = window.miniClawDesktop ? 'desktop' : 'web'
        if (source === 'desktop') {
          await heartbeatApprovalClient(APPROVAL_CLIENT_ID)
        }
        const result = await sendPrompt(selectedId, {
          text,
          streamingBehavior,
          source,
        })
        setNotice(result.mode === 'started' ? 'MiniClaw 正在处理' : '消息已排队')
      } catch (cause) {
        setError(toMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [selectedId],
  )

  const handleApprovalDecision = useCallback(
    async (id: string, decision: ApprovalDecision): Promise<ApprovalRecord> => {
      const approval = await decideApproval(id, decision)
      setRecoveredApprovals((previous) => {
        const index = previous.findIndex((item) => item.id === approval.id)
        if (index === -1) return previous
        const next = [...previous]
        next[index] = approval
        return next
      })
      return approval
    },
    [],
  )

  return (
    <div className="chat-app">
      <SessionSidebar
        runs={runs}
        selectedId={selectedId}
        busy={busy}
        titles={sidebarTitles}
        onSelect={selectRun}
        onNew={() => void createConversation(
          currentFolder === '正在连接项目…' ? undefined : currentFolder,
        )}
      />

      <section className="workspace">
        <header className="workspace-header">
          <div className="folder-context" title={currentFolder}>
            <FolderOpen size={23} weight="regular" aria-hidden="true" />
            <strong>{currentFolder}</strong>
          </div>
          <button
            className="header-button"
            type="button"
            onClick={() => void changeFolder()}
            disabled={busy}
          >
            更换文件夹
          </button>
          <span className={`connection-state${networkError ? ' error' : ''}`}>
            {networkError ? '服务异常' : health ? '已连接' : '连接中'}
          </span>
          <button
            className="header-button details-button"
            type="button"
            onClick={() => setDetailsOpen(true)}
          >
            <ListBullets size={18} aria-hidden="true" />
            运行详情
          </button>
        </header>

        <div className="message-banners" aria-live="polite">
          {networkError ? <div className="banner banner-error">{networkError}</div> : null}
          {error ? <div className="banner banner-error">{error}</div> : null}
          {notice ? <div className="banner banner-notice">{notice}</div> : null}
        </div>

        <main className="conversation-area">
          <ChatTimeline
            events={events}
            approvals={recoveredApprovals}
            hasRun={Boolean(selectedId)}
            onApprovalDecision={handleApprovalDecision}
          />
        </main>

        <footer className="composer-shell">
          <PromptComposer runId={selectedId} busy={busy} onSend={handlePrompt} />
        </footer>
      </section>

      {detailsOpen ? (
        <div className="drawer-layer">
          <button
            className="drawer-backdrop"
            type="button"
            aria-label="关闭运行详情"
            onClick={() => setDetailsOpen(false)}
          />
          <aside className="technical-drawer" aria-label="运行详情">
            <div className="drawer-header">
              <div>
                <h2>运行详情</h2>
                <p>状态、配置与实时事件</p>
              </div>
              <div className="drawer-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label="刷新运行详情"
                  onClick={() => setRefreshKey((value) => value + 1)}
                >
                  <ArrowClockwise size={19} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭运行详情"
                  onClick={() => setDetailsOpen(false)}
                >
                  <X size={20} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="drawer-content">
              {selectedRun ? (
                <RunDetail run={selectedRun} />
              ) : (
                <p className="muted">请先选择一个会话。</p>
              )}
              <EventFeed events={events} hasRun={Boolean(selectedId)} />
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  )
}
