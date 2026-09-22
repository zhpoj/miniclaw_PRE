import { type FormEvent, useState } from 'react'

import type { StreamingBehavior } from '../lib/api'

interface Props {
  runId: string | null
  busy: boolean
  onSend: (
    text: string,
    streamingBehavior?: StreamingBehavior,
  ) => Promise<void>
}

/** Composer driving `POST /api/agent/runs/:id/prompt`. */
export default function PromptComposer({ runId, busy, onSend }: Props) {
  const [text, setText] = useState('')
  const [behavior, setBehavior] = useState<'auto' | StreamingBehavior>('auto')

  const submit = async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault()
    const value = text.trim()
    if (!runId || value.length === 0) return
    setText('')
    await onSend(value, behavior === 'auto' ? undefined : behavior)
  }

  const sendable = Boolean(runId) && text.trim().length > 0 && !busy

  return (
    <form className="panel" onSubmit={submit}>
      <div className="panel-head">
        <h2>Prompt</h2>
        <span className="muted">POST /api/agent/runs/:id/prompt</span>
      </div>

      <textarea
        className="prompt-input"
        rows={4}
        value={text}
        disabled={!runId}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && sendable) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={runId ? '输入指令，Ctrl + Enter 发送' : '先选择一个 run'}
      />

      <div className="prompt-actions">
        <label className="field inline">
          <span>streamingBehavior</span>
          <select
            value={behavior}
            onChange={(event) =>
              setBehavior(event.target.value as 'auto' | StreamingBehavior)
            }
          >
            <option value="auto">自动（空闲即开始）</option>
            <option value="steer">steer</option>
            <option value="followUp">followUp</option>
          </select>
        </label>
        <button className="btn btn-primary" type="submit" disabled={!sendable}>
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
    </form>
  )
}
