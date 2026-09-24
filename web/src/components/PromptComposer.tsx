import { type FormEvent, useState } from 'react'
import { PaperPlaneRight } from '@phosphor-icons/react'

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
    <form className="chat-composer" onSubmit={submit}>
      <textarea
        className="composer-input"
        rows={3}
        value={text}
        disabled={!runId}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            sendable
          ) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={runId ? '输入你的问题，帮我处理代码、解释问题、完成任务…' : '先新建一个会话'}
      />

      <div className="composer-actions">
        <label className="composer-mode">
          <span>执行模式</span>
          <select
            value={behavior}
            onChange={(event) =>
              setBehavior(event.target.value as 'auto' | StreamingBehavior)
            }
          >
            <option value="auto">自动</option>
            <option value="steer">立即调整</option>
            <option value="followUp">排队执行</option>
          </select>
        </label>
        <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
        <button className="send-button" type="submit" disabled={!sendable}>
          <PaperPlaneRight size={19} weight="fill" aria-hidden="true" />
          {busy ? '发送中' : '发送'}
        </button>
      </div>
    </form>
  )
}
