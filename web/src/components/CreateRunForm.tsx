import { type FormEvent, useState } from 'react'

import type { CreateRunInput, ThinkingLevel } from '../lib/api'

const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

interface Props {
  busy: boolean
  defaultCwd?: string
  onCreate: (input: CreateRunInput) => Promise<void>
}

/** Form driving `POST /api/agent/runs`. Empty fields fall back to server defaults. */
export default function CreateRunForm({ busy, defaultCwd, onCreate }: Props) {
  const [cwd, setCwd] = useState('')
  const [model, setModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState('')
  const [tools, setTools] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [persistSession, setPersistSession] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input: CreateRunInput = {}
    const trimmedTools = tools
      .split(',')
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0)

    if (cwd.trim()) input.cwd = cwd.trim()
    if (model.trim()) input.model = model.trim()
    if (thinkingLevel) input.thinkingLevel = thinkingLevel as ThinkingLevel
    if (trimmedTools.length > 0) input.tools = trimmedTools
    if (systemPrompt.trim()) input.systemPrompt = systemPrompt.trim()
    if (persistSession) input.persistSession = true

    await onCreate(input)
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="panel-head">
        <h2>新建 run</h2>
        <span className="muted">POST /api/agent/runs</span>
      </div>

      <label className="field">
        <span>cwd</span>
        <input
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder={defaultCwd ?? '留空使用引擎默认工作目录'}
        />
      </label>

      <label className="field">
        <span>model</span>
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="provider/model[:thinking]"
        />
      </label>

      <label className="field">
        <span>thinkingLevel</span>
        <select
          value={thinkingLevel}
          onChange={(event) => setThinkingLevel(event.target.value)}
        >
          <option value="">跟随默认</option>
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>tools（逗号分隔）</span>
        <input
          value={tools}
          onChange={(event) => setTools(event.target.value)}
          placeholder="read,bash,edit,write"
        />
      </label>

      <label className="field">
        <span>systemPrompt</span>
        <textarea
          rows={3}
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          placeholder="留空使用 pi 默认系统提示词"
        />
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={persistSession}
          onChange={(event) => setPersistSession(event.target.checked)}
        />
        <span>persistSession（会话落盘）</span>
      </label>

      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? '创建中…' : '创建 run'}
      </button>
    </form>
  )
}
