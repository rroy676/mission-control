import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const mocks = vi.hoisted(() => ({ db: null as Database.Database | null, tenant: 'tnt_alpha' }))
vi.mock('@/lib/db', () => ({ getDatabase: () => mocks.db, logAuditEvent: vi.fn() }))
vi.mock('@/lib/tenant-context', () => ({ requireTenantContext: (_user: unknown, requested?: string | null) => {
  const key = requested || mocks.tenant
  if (!['tnt_alpha', 'tnt_beta'].includes(key)) return { error: 'denied' }
  return { id: key === 'tnt_alpha' ? 1 : 2, tenantKey: key, slug: key.slice(4), displayName: key, status: 'active', membershipRole: 'owner', userId: 1 }
} }))
import { createMemory, getMemory, listMemory, updateMemory, createHandoff } from '@/lib/working-memory'

const user = { id: 1, username: 'tester', role: 'admin', workspace_id: 11, tenant_id: 1 } as any

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(`
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
  mocks.db.prepare('INSERT INTO tenants VALUES (1,?), (2,?)').run('tnt_alpha', 'tnt_beta')
  mocks.db.prepare('INSERT INTO workspaces VALUES (11,1),(22,2)').run()
  mocks.db.prepare('INSERT INTO projects VALUES (101,11),(202,22)').run()
  mocks.db.prepare('INSERT INTO agents VALUES (1001,?,11),(2002,?,22)').run('Hermes', 'Codex')
  mocks.db.prepare('INSERT INTO tasks VALUES (3001,11),(4004,22)').run()
  mocks.db.prepare('INSERT INTO tenant_model_profiles VALUES (5001,1),(6006,2)').run()
})
afterEach(() => mocks.db?.close())

describe('working-memory repository tenant isolation', () => {
  it('scopes list, exact get, update, filters, current-state supersession, and references', () => {
    const alpha = createMemory(user, { memory_type:'current_state', scope:'project', project_id:'101', agent_id:null, task_id:null, title:'Alpha state', content:'A', source:'test', importance:'high', metadata:{} })
    const beta = createMemory(user, { memory_type:'current_state', scope:'project', project_id:'202', agent_id:null, task_id:null, title:'Beta state', content:'B', source:'test', importance:'normal', metadata:{} }, 'tnt_beta')
    expect(listMemory(user, {}, 'tnt_alpha').map((x) => x.memory_id)).toEqual([alpha.memory_id])
    expect(getMemory(user, beta.memory_id, 'tnt_alpha')).toBeNull()
    expect(() => updateMemory(user, beta.memory_id, { promotion_status:'promoted' }, 'tnt_alpha')).toThrow()
    const replacement = createMemory(user, { memory_type:'current_state', scope:'project', project_id:'101', agent_id:null, task_id:null, title:'Alpha replacement', content:'A2', source:'test', importance:'high', metadata:{} })
    expect(getMemory(user, alpha.memory_id)?.lifecycle_status).toBe('superseded')
    expect(getMemory(user, replacement.memory_id)?.lifecycle_status).toBe('active')
    expect(() => createMemory(user, { memory_type:'operational_note', scope:'project', project_id:'202', agent_id:null, task_id:null, title:'bad', content:'x', source:'test', importance:'normal', metadata:{} })).toThrow()
  })
  it('rejects cross-tenant handoff agents and model profiles', () => {
    expect(() => createHandoff(user, { source_agent:'Hermes', destination_agent:'Codex', objective:'x', relevant_context:'x', expected_result:'x' })).toThrow()
    expect(() => createMemory(user, { memory_type:'operational_note', scope:'tenant/company', project_id:null, agent_id:null, task_id:null, title:'bad profile', content:'x', source:'test', importance:'normal', metadata:{ model_profile_id:6006 } })).toThrow()
  })
})
