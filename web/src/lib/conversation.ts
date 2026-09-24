import type { AgentEventRecord } from './api'

export type ConversationItem =
  | {
      id: string
      kind: 'message'
      role: 'user' | 'assistant'
      text: string
      at: string
    }
  | {
      id: string
      kind: 'activity'
      label: string
      status: 'running' | 'done' | 'error'
      at: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) ? contentText(block.text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return isRecord(content) ? contentText(content.text) : ''
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    read: '读取项目文件',
    edit: '修改项目文件',
    write: '写入项目文件',
    bash: '执行终端命令',
    powershell: '执行 PowerShell 命令',
  }
  return labels[name] ?? `运行工具：${name}`
}

export function buildConversation(events: AgentEventRecord[]): ConversationItem[] {
  const items: ConversationItem[] = []
  const activityIndexes = new Map<string, number>()
  let streamingText = ''
  let streamingAt = ''

  for (const event of events) {
    const payload = isRecord(event.payload) ? event.payload : {}

    if (event.type === 'message_update') {
      const update = isRecord(payload.assistantMessageEvent)
        ? payload.assistantMessageEvent
        : {}
      if (update.type === 'text_delta' && typeof update.delta === 'string') {
        if (!streamingText) streamingAt = event.at
        streamingText += update.delta
      }
      continue
    }

    if (event.type === 'message_end') {
      const message = isRecord(payload.message) ? payload.message : {}
      const role = message.role
      if (role === 'user' || role === 'assistant') {
        const text = contentText(message.content).trim()
        if (text) {
          items.push({
            id: `message-${event.seq}`,
            kind: 'message',
            role,
            text,
            at: event.at,
          })
        }
        if (role === 'assistant') {
          streamingText = ''
          streamingAt = ''
        }
      }
      continue
    }

    if (event.type === 'tool_execution_start') {
      const toolCallId =
        typeof payload.toolCallId === 'string'
          ? payload.toolCallId
          : String(event.seq)
      const toolName =
        typeof payload.toolName === 'string' ? payload.toolName : 'unknown'
      activityIndexes.set(toolCallId, items.length)
      items.push({
        id: `activity-${toolCallId}`,
        kind: 'activity',
        label: toolLabel(toolName),
        status: 'running',
        at: event.at,
      })
      continue
    }

    if (event.type === 'tool_execution_end') {
      const toolCallId =
        typeof payload.toolCallId === 'string'
          ? payload.toolCallId
          : String(event.seq)
      const existingIndex = activityIndexes.get(toolCallId)
      const status = payload.isError === true ? 'error' : 'done'
      if (existingIndex !== undefined) {
        const existing = items[existingIndex]
        if (existing?.kind === 'activity') {
          items[existingIndex] = { ...existing, status }
        }
      } else {
        const toolName =
          typeof payload.toolName === 'string' ? payload.toolName : 'unknown'
        items.push({
          id: `activity-${toolCallId}`,
          kind: 'activity',
          label: toolLabel(toolName),
          status,
          at: event.at,
        })
      }
    }
  }

  if (streamingText.trim()) {
    items.push({
      id: 'message-streaming',
      kind: 'message',
      role: 'assistant',
      text: streamingText.trim(),
      at: streamingAt,
    })
  }

  return items
}
