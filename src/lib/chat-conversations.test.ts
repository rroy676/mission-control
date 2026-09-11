import { describe, expect, it } from 'vitest'
import { normalizePersistedHermesConversations } from './chat-conversations'

describe('normalizePersistedHermesConversations', () => {
  it('rehydrates project and company conversations without duplicates', () => {
    const rows = normalizePersistedHermesConversations({ conversations: [
      { conversation_id: 'gateway:ignored', project_id: 7, project_name: 'Grocery' },
      { conversation_id: 'hermes:project', project_id: 7, project_name: 'Quebec Grocery savings app', agent_name: 'hermes', last_message_at: 20, last_message: { id: 2, content: 'ok' } },
      { conversation_id: 'hermes:project', project_id: 7, project_name: 'Quebec Grocery savings app', agent_name: 'hermes', last_message_at: 19 },
      { conversation_id: 'hermes:company', project_id: null, project_name: null, agent_name: 'hermes', last_message_at: 10 },
    ] })

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 'hermes:project', projectId: 7, name: 'Hermes · Quebec Grocery savings app' })
    expect(rows[1]).toMatchObject({ id: 'hermes:company', projectId: null, name: 'Hermes · Company' })
  })

  it('treats malformed or empty API payloads as an empty list', () => {
    expect(normalizePersistedHermesConversations(null)).toEqual([])
    expect(normalizePersistedHermesConversations({ conversations: [{ conversation_id: 'not-hermes' }, {}] })).toEqual([])
  })
})
