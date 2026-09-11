export type PersistedHermesConversation = {
  id: string
  name: string
  kind: 'hermes'
  source: 'chat'
  agentName: string
  projectId: number | null
  projectName: string | null
  participants: string[]
  lastMessage?: {
    id: number
    conversation_id: string
    from_agent: string
    to_agent: string | null
    content: string
    message_type: string
    created_at: number
  }
  unreadCount: number
  updatedAt: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Normalize the server-owned persisted Hermes list for the chat sidebar. */
export function normalizePersistedHermesConversations(payload: unknown): PersistedHermesConversation[] {
  const record = asRecord(payload)
  const rows = Array.isArray(record?.conversations) ? record.conversations : []
  const seen = new Set<string>()

  return rows.flatMap((value) => {
    const row = asRecord(value)
    const id = readString(row?.conversation_id)
    if (!id || !id.startsWith('hermes:') || seen.has(id)) return []
    seen.add(id)

    const projectId = readNumber(row?.project_id) ?? null
    const agentName = readString(row?.agent_name) || 'hermes'
    const projectName = readString(row?.project_name) || null
    const last = asRecord(row?.last_message)
    const createdAt = readNumber(row?.last_message_at) || Math.floor(Date.now() / 1000)
    const lastMessageId = readNumber(last?.id)

    return [{
      id,
      name: projectName ? `Hermes · ${projectName}` : 'Hermes · Company',
      kind: 'hermes' as const,
      source: 'chat' as const,
      agentName,
      projectId,
      projectName,
      participants: [agentName],
      ...(lastMessageId !== undefined ? {
        lastMessage: {
          id: lastMessageId,
          conversation_id: id,
          from_agent: readString(last?.from_agent) || agentName,
          to_agent: readString(last?.to_agent) || null,
          content: readString(last?.content) || '',
          message_type: readString(last?.message_type) || 'text',
          created_at: readNumber(last?.created_at) || createdAt,
        },
      } : {}),
      unreadCount: readNumber(row?.unread_count) || 0,
      updatedAt: createdAt,
    }]
  })
}
