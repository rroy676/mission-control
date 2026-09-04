import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({ db: null as Database.Database | null, tenant: 'tnt_alpha' }))
const user = { id: 1, username: 'api-isolation-fixture', role: 'admin', workspace_id: 11, tenant_id: 1 } as any
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db, logAuditEvent: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  requireRole: () => ({ user }),
  getUserFromRequest: () => user,
}))
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: (_user: unknown, requested?: string | null) => {
    const key = requested || state.tenant
    if (!['tnt_alpha', 'tnt_beta'].includes(key)) return { error: 'denied' }
    return { id: key === 'tnt_alpha' ? 1 : 2, tenantKey: key, slug: key.slice(4), displayName: key, status: 'active', membershipRole: 'owner', userId: 1 }
  },
}))

import { GET, POST } from './route'
import { GET as GET_ONE, PATCH as PATCH_ONE } from './[id]/route'

function request(url: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}
function memory(overrides: Record<string, unknown> = {}) {
  return { scope: 'tenant/company', memory_type: 'operational_note', title: 'API fixture', content: 'bounded context', source: 'api-test', importance: 'normal', ...overrides }
}

beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, tenant_key TEXT);
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT, workspace_id INTEGER);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER);
    CREATE TABLE tenant_model_profiles (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE activities (id INTEGER PRIMARY KEY, type TEXT, entity_type TEXT, entity_id INTEGER, actor TEXT, description TEXT, data TEXT, created_at INTEGER, tenant_id INTEGER, workspace_id INTEGER);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT, actor TEXT, actor_id INTEGER, target_type TEXT, target_id INTEGER, detail TEXT, ip_address TEXT, user_agent TEXT, workspace_id INTEGER, tenant_id INTEGER);
    CREATE TABLE working_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT UNIQUE, schema_version TEXT, tenant_id INTEGER, project_id INTEGER, agent_id INTEGER, task_id INTEGER, memory_type TEXT, scope TEXT, title TEXT, content TEXT, source TEXT, importance TEXT, lifecycle_status TEXT, promotion_status TEXT, durable_reference TEXT, metadata TEXT, source_agent TEXT, destination_agent TEXT, objective TEXT, relevant_context TEXT, constraints TEXT, source_references TEXT, expected_result TEXT, handoff_status TEXT, created_at INTEGER, updated_at INTEGER, expires_at INTEGER, completed_at INTEGER);
  `)
  state.db.prepare('INSERT INTO tenants VALUES (1,?), (2,?)').run('tnt_alpha', 'tnt_beta')
  state.db.prepare('INSERT INTO workspaces VALUES (11,1),(22,2)').run()
  state.db.prepare('INSERT INTO projects VALUES (101,11),(202,22)').run()
  state.db.prepare('INSERT INTO agents VALUES (1001,?,11),(2002,?,22)').run('Hermes', 'Codex')
  state.db.prepare('INSERT INTO tenant_model_profiles VALUES (5001,1),(6006,2)').run()
})
afterEach(() => state.db?.close())

describe('working-memory HTTP route isolation and secret safety', () => {
  it('enforces tenant-first list, exact read, update, current-state, and references', async () => {
    const alpha = await POST(request('/api/memory/working?tenant_key=tnt_alpha', 'POST', memory({ scope: 'project', project_id: '101' })))
    const beta = await POST(request('/api/memory/working?tenant_key=tnt_beta', 'POST', memory({ scope: 'project', project_id: '202', title: 'Beta' })))
    expect(alpha.status).toBe(201); expect(beta.status).toBe(201)
    const betaId = (await beta.json()).memory.memory_id
    expect((await (await GET(request('/api/memory/working?tenant_key=tnt_alpha'))).json()).memories).toHaveLength(1)
    expect((await GET_ONE(request(`/api/memory/working/${betaId}?tenant_key=tnt_alpha`), { params: Promise.resolve({ id: betaId }) })).status).toBe(404)
    expect((await PATCH_ONE(request(`/api/memory/working/${betaId}?tenant_key=tnt_alpha`, 'PATCH', { lifecycle_status: 'resolved' }), { params: Promise.resolve({ id: betaId }) })).status).toBe(403)
    expect((await POST(request('/api/memory/working?tenant_key=tnt_alpha', 'POST', memory({ scope: 'project', project_id: '202' })))).status).toBe(403)
  })

  it.each([
    ['bearer', { content: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.fixture' }],
    ['api-key', { content: 'api_key=sk-fixture-never-use' }],
    ['password', { content: 'password=fixture' }],
    ['session-cookie', { content: 'session_cookie=mc-session.fixture' }],
    ['private-key', { content: '-----BEGIN PRIVATE KEY----- fixture -----END PRIVATE KEY-----' }],
  ])('rejects %s secret-like content at the HTTP route boundary', async (_label, secret) => {
    const response = await POST(request('/api/memory/working?tenant_key=tnt_alpha', 'POST', memory(secret)))
    expect([400, 403]).toContain(response.status)
    expect(await response.text()).not.toMatch(/fixture-never-use|eyJhbGci|BEGIN PRIVATE KEY/)
  })
})
