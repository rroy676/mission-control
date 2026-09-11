import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Database.Database | null }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: {},
  logAuditEvent: vi.fn(),
}))

import { bindingForSession } from '@/lib/hermes-coo'

const user = { tenant_id: 1, workspace_id: 1 } as any

function insertBinding(input: { tenantId?: number; workspaceId?: number; agentId?: number; projectId: number | null; sessionId: string }) {
  state.db?.prepare(`
    INSERT INTO hermes_runtime_bindings (tenant_id, workspace_id, agent_id, project_id, hermes_session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.tenantId ?? 1, input.workspaceId ?? 1, input.agentId ?? 1, input.projectId, input.sessionId)
}

describe('Hermes COO server-owned session binding', () => {
  beforeEach(() => {
    state.db = new Database(':memory:')
    state.db.exec(`
      CREATE TABLE hermes_runtime_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        workspace_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        project_id INTEGER,
        hermes_session_id TEXT NOT NULL
      )
    `)
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
  })

  it('resolves the exact conversation-specific project binding', () => {
    const sessionId = 'mc_1_1_1_7_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    insertBinding({ projectId: 7, sessionId })

    expect(bindingForSession(user, sessionId)).toMatchObject({
      tenantId: 1, workspaceId: 1, agentId: 1, projectId: 7, sessionId,
    })
  })

  it('maps one canonical Hermes base id back to its persisted conversation binding', () => {
    const sessionId = 'mc_1_1_1_7_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    insertBinding({ projectId: 7, sessionId })

    expect(bindingForSession(user, 'mc_1_1_1_7')).toMatchObject({ projectId: 7, sessionId })
    expect(bindingForSession(user, `hermes:${sessionId}`)).toMatchObject({ projectId: 7, sessionId })
  })

  it('rejects ambiguous base ids instead of choosing a conversation', () => {
    insertBinding({ projectId: 7, sessionId: 'mc_1_1_1_7_cccccccccccccccccccccccccccccccc' })
    insertBinding({ projectId: 7, sessionId: 'mc_1_1_1_7_dddddddddddddddddddddddddddddddd' })

    expect(() => bindingForSession(user, 'mc_1_1_1_7')).toThrow('Hermes session is not bound to an authorized project')
  })

  it.each([
    ['general conversation', 'mc_1_1_1_default'],
    ['foreign project', 'mc_1_1_1_88'],
    ['foreign tenant', 'mc_2_1_1_7'],
    ['model-supplied fake id', 'mc_1_1_1_7_fake'],
    ['missing binding', 'not-a-session'],
  ])('rejects %s without project authority', (_label, sessionId) => {
    insertBinding({ projectId: null, sessionId: 'mc_1_1_1_default_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })
    insertBinding({ tenantId: 2, projectId: 7, sessionId: 'mc_2_1_1_7_gggggggggggggggggggggggggggggggg' })

    expect(() => bindingForSession(user, sessionId)).toThrow('Hermes session is not bound to an authorized project')
  })
})
