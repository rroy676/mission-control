import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  bindingForSession: vi.fn(),
  createHermesTask: vi.fn(),
  saveHermesMemory: vi.fn(),
  logActivity: vi.fn(),
  logAuditEvent: vi.fn(),
  getDatabase: vi.fn(() => ({})),
}))

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/db', () => ({
  db_helpers: { logActivity: mocks.logActivity },
  getDatabase: mocks.getDatabase,
  logAuditEvent: mocks.logAuditEvent,
}))
vi.mock('@/lib/hermes-coo', () => ({
  bindingForSession: mocks.bindingForSession,
  createHermesTask: mocks.createHermesTask,
  saveHermesMemory: mocks.saveHermesMemory,
  hermesCreateTaskSchema: z.object({
    title: z.string().trim().min(1).max(240),
    objective: z.string().trim().min(1).max(5_000),
    acceptance_criteria: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
    dependencies: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    assignee: z.string().trim().min(1).max(100).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  }).strict(),
}))

import { POST } from '@/app/api/hermes/actions/route'

const user = { id: 1, username: 'hermes', display_name: 'Hermes', role: 'admin', tenant_id: 1, workspace_id: 1 } as any
const projectBinding = { tenantId: 1, workspaceId: 1, agentId: 1, projectId: 7, sessionId: 'mc_1_1_1_7_conversation' }

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/hermes/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Hermes structured action binding boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireRole.mockReturnValue({ user })
    mocks.bindingForSession.mockReturnValue(projectBinding)
    mocks.createHermesTask.mockImplementation((_user: unknown, binding: typeof projectBinding, input: { title: string }, idempotencyKey?: string) => ({
      id: 7001, title: input.title, project_id: binding.projectId, tenant_id: binding.tenantId, workspace_id: binding.workspaceId,
      idempotent: idempotencyKey === 'retry-key',
    }))
  })

  it('allows an authorized canonical project session using persisted project 7', async () => {
    const response = await POST(request({
      action: 'CREATE_TASK', session_id: 'mc_1_1_1_7', idempotency_key: 'first-key',
      parameters: { title: 'Project task', objective: 'Bounded objective' },
    }))
    expect(response.status).toBe(200)
    expect(mocks.bindingForSession).toHaveBeenCalledWith(user, 'mc_1_1_1_7')
    expect(mocks.createHermesTask).toHaveBeenCalledWith(user, projectBinding, expect.objectContaining({ title: 'Project task' }), 'first-key')
    expect((await response.json()).result).toMatchObject({ project_id: 7, tenant_id: 1, workspace_id: 1 })
  })

  it.each([
    ['general conversation', new Error('Hermes session is not bound to an authorized project')],
    ['foreign project', new Error('Project context invalid')],
    ['foreign tenant', new Error('Hermes binding is outside the active tenant/workspace')],
    ['missing binding', new Error('Hermes session is not bound to an authorized project')],
  ])('rejects %s without a side effect', async (_label, error) => {
    mocks.bindingForSession.mockImplementation(() => { throw error })
    const response = await POST(request({
      action: 'CREATE_TASK', session_id: 'mc_1_1_1_7',
      parameters: { title: 'Denied task', objective: 'Must not execute' },
    }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ classification: 'unauthorized_or_invalid' })
    expect(mocks.createHermesTask).not.toHaveBeenCalled()
    expect(mocks.logActivity).toHaveBeenCalledOnce()
    expect(mocks.logAuditEvent).toHaveBeenCalledOnce()
  })

  it('rejects model-supplied project and tenant overrides before execution', async () => {
    const response = await POST(request({
      action: 'CREATE_TASK', session_id: projectBinding.sessionId,
      parameters: { title: 'Fake scope', objective: 'Must be ignored', project_id: 999, tenant_id: 99 },
    }))
    expect(response.status).toBe(403)
    expect((await response.json()).classification).toBe('unauthorized_or_invalid')
    expect(mocks.createHermesTask).not.toHaveBeenCalled()
  })

  it('preserves idempotent retry behavior for the same bound action', async () => {
    const body = { action: 'CREATE_TASK', session_id: projectBinding.sessionId, idempotency_key: 'retry-key', parameters: { title: 'Retry task', objective: 'One side effect' } }
    const first = await POST(request(body))
    const second = await POST(request(body))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await second.json()).result).toMatchObject({ id: 7001, project_id: 7, idempotent: true })
    expect(mocks.createHermesTask).toHaveBeenCalledTimes(2)
  })
})
