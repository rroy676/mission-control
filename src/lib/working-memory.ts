import type Database from 'better-sqlite3'
import { getDatabase, logAuditEvent } from './db'
import { requireTenantContext, type TenantContext } from './tenant-context'
import { portableMemorySchema, newMemoryId, rejectSecrets, classifySignificance, MEMORY_SCHEMA_VERSION, type PortableMemory, type MemoryType } from './portable-memory'
import type { User } from './auth'

const MAX_LIMIT = 100
const now = () => Math.floor(Date.now() / 1000)
export type MemoryInput = Omit<PortableMemory, 'memory_id'|'schema_version'|'tenant_id'|'created_at'|'updated_at'|'lifecycle_status'|'promotion_status'|'metadata'> & { lifecycle_status?: PortableMemory['lifecycle_status']; promotion_status?: PortableMemory['promotion_status']; metadata?: PortableMemory['metadata'] }
export type MemoryQuery = Partial<Pick<PortableMemory, 'project_id'|'agent_id'|'task_id'|'memory_type'|'importance'|'lifecycle_status'|'promotion_status'|'source'>> & { memory_id?: string; recency_since?: number; limit?: number; offset?: number }

function json(v: unknown) { return JSON.stringify(v ?? {}) }
function parseRow(row: any): PortableMemory & Record<string, unknown> {
  const base = portableMemorySchema.parse({ memory_id: row.memory_id, schema_version: row.schema_version, tenant_id: row.tenant_key, project_id: row.project_key, agent_id: row.agent_key, task_id: row.task_key, memory_type: row.memory_type, scope: row.scope, title: row.title, content: row.content, source: row.source, importance: row.importance, lifecycle_status: row.lifecycle_status, promotion_status: row.promotion_status, durable_reference: row.durable_reference, created_at: row.created_at, updated_at: row.updated_at, expires_at: row.expires_at, metadata: JSON.parse(row.metadata || '{}') })
  const linkage = { promotion_state: row.promotion_state || row.promotion_status || 'none', durable_id: row.durable_id || null, durable_path: row.durable_path || null, durable_commit_sha: row.durable_commit_sha || null, promoted_at: row.promoted_at || null, promoted_by: row.promoted_by || null, promotion_type: row.promotion_type || null }
  if (row.memory_type !== 'handoff') return { ...base, ...linkage }
  return { ...base, ...linkage, source_agent: row.source_agent, destination_agent: row.destination_agent, objective: row.objective, relevant_context: row.relevant_context, constraints: row.constraints, source_references: JSON.parse(row.source_references || '[]'), expected_result: row.expected_result, status: row.handoff_status, completed_at: row.completed_at }
}

function verifyRef(db: Database.Database, tenant: TenantContext, kind: 'project'|'agent'|'task', id: string | null | undefined): number | null {
  if (!id) return null
  const numeric = Number(id)
  if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`${kind} reference is invalid or not in active tenant`)
  const queries = { project: 'SELECT p.id FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=? AND w.tenant_id=?', agent: 'SELECT a.id FROM agents a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=? AND w.tenant_id=?', task: 'SELECT t.id FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=? AND w.tenant_id=?' }
  if (!db.prepare(queries[kind]).get(numeric, tenant.id)) throw new Error(`${kind} reference is invalid or not in active tenant`)
  return numeric
}
function tenantKey(db: Database.Database, id: number) { return (db.prepare('SELECT tenant_key FROM tenants WHERE id=?').get(id) as { tenant_key: string }).tenant_key }
function workspaceId(db: Database.Database, tenantId: number) { return (db.prepare('SELECT id FROM workspaces WHERE tenant_id=? ORDER BY id LIMIT 1').get(tenantId) as { id: number } | undefined)?.id || 1 }
function activity(db: Database.Database, tenant: TenantContext, actor: string, type: string, memoryId: string, description: string, data: Record<string, unknown>) { db.prepare('INSERT INTO activities (type, entity_type, entity_id, actor, description, data, created_at, tenant_id, workspace_id) VALUES (?,?,?,?,?,?,unixepoch(),?,?)').run(type, 'working_memory', 0, actor, description, json({ ...data, memory_id: memoryId, tenant_id: tenant.id }), tenant.id, workspaceId(db, tenant.id)) }
function activeContext(user: User, key?: string | null): TenantContext { const context = requireTenantContext(user, key); if (!('id' in context)) throw new Error('Tenant context is missing or unauthorized'); return context }

export function createMemory(user: User, input: MemoryInput, requestedTenantKey?: string | null): PortableMemory {
  const context = activeContext(user, requestedTenantKey)
  const db = getDatabase(); rejectSecrets(input)
  if (input.metadata && input.metadata.model_profile_id !== undefined) {
    const profileId = Number(input.metadata.model_profile_id)
    if (!Number.isInteger(profileId) || !db.prepare('SELECT id FROM tenant_model_profiles WHERE id=? AND tenant_id=?').get(profileId, context.id)) throw new Error('Model profile reference is invalid or not in active tenant')
  }
  if (input.scope === 'project' && !input.project_id || input.scope === 'agent' && !input.agent_id || input.scope === 'task' && !input.task_id) throw new Error('Memory scope requires its matching reference')
  const projectId = verifyRef(db, context, 'project', input.project_id), agentId = verifyRef(db, context, 'agent', input.agent_id), taskId = verifyRef(db, context, 'task', input.task_id)
  if (input.memory_type === 'current_state') {
    const currentClause = projectId === null ? 'project_id IS NULL' : 'project_id=?'
    const currentParams = projectId === null ? [context.id] : [context.id, projectId]
    db.prepare(`UPDATE working_memory SET lifecycle_status='superseded', updated_at=unixepoch() WHERE tenant_id=? AND ${currentClause} AND memory_type='current_state' AND lifecycle_status='active'`).run(...currentParams)
  }
  const id = newMemoryId(), timestamp = now(), promotion = input.promotion_status || (classifySignificance(input) === 'promotion-candidate' ? 'promotion-candidate' : 'none')
  const result = portableMemorySchema.parse({ ...input, memory_id: id, schema_version: MEMORY_SCHEMA_VERSION, tenant_id: context.tenantKey, project_id: projectId?.toString() ?? null, agent_id: agentId?.toString() ?? null, task_id: taskId?.toString() ?? null, created_at: timestamp, updated_at: timestamp, lifecycle_status: input.lifecycle_status || 'active', promotion_status: promotion, metadata: input.metadata || {} })
  db.prepare('INSERT INTO working_memory (memory_id,schema_version,tenant_id,project_id,agent_id,task_id,memory_type,scope,title,content,source,importance,lifecycle_status,promotion_status,durable_reference,metadata,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(result.memory_id,result.schema_version,context.id,projectId,agentId,taskId,result.memory_type,result.scope,result.title,result.content,result.source,result.importance,result.lifecycle_status,result.promotion_status,result.durable_reference||null,json(result.metadata),timestamp,timestamp,result.expires_at||null)
  activity(db, context, user.username, 'memory_created', id, `Working memory created: ${result.title}`, { memory_type: result.memory_type, promotion_status: result.promotion_status })
  logAuditEvent({ action: 'memory_created', actor: user.username, actor_id: user.id, target_type: 'working_memory', detail: { memory_id: id, tenant_id: context.id }, workspace_id: workspaceId(db, context.id), tenant_id: context.id })
  return result
}

export interface HandoffInput {
  project_id?: string | null; source_agent: string; destination_agent: string; objective: string; relevant_context: string; constraints?: string; source_references?: string[]; expected_result: string; model_profile_id?: number | null
}
export function createHandoff(user: User, input: HandoffInput, requestedTenantKey?: string | null) {
  const context = activeContext(user, requestedTenantKey)
  const db = getDatabase(); rejectSecrets(input)
  const agent = (name: string) => db.prepare('SELECT a.id FROM agents a JOIN workspaces w ON w.id=a.workspace_id WHERE a.name=? AND w.tenant_id=?').get(name, context.id) as {id:number}|undefined
  const source = agent(input.source_agent), destination = agent(input.destination_agent)
  if (!source || !destination) throw new Error('Handoff agents must belong to active tenant')
  const refs = input.source_references || []; if (refs.length > 20 || refs.some((v) => typeof v !== 'string' || v.length > 500)) throw new Error('Invalid handoff source references')
  const memory = createMemory(user, { memory_type:'handoff', scope:input.project_id ? 'project' : 'tenant/company', project_id:input.project_id || null, agent_id:source.id.toString(), task_id:null, title:`${input.source_agent} → ${input.destination_agent}`, content:input.relevant_context, source:'agent-handoff', importance:'normal', durable_reference:null, expires_at:null, metadata:{ source_agent:input.source_agent, destination_agent:input.destination_agent, objective:input.objective, relevant_context:input.relevant_context, constraints:input.constraints || '', source_references:JSON.stringify(refs), expected_result:input.expected_result, status:'pending', ...(input.model_profile_id == null ? {} : { model_profile_id: input.model_profile_id }) } }, requestedTenantKey)
  db.prepare('UPDATE working_memory SET source_agent=?,destination_agent=?,objective=?,relevant_context=?,constraints=?,source_references=?,expected_result=?,handoff_status=? WHERE memory_id=? AND tenant_id=?').run(input.source_agent,input.destination_agent,input.objective,input.relevant_context,input.constraints||null,JSON.stringify(refs),input.expected_result,'pending',memory.memory_id,context.id)
  activity(db, context, user.username, 'handoff_created', memory.memory_id, `Handoff created: ${memory.title}`, { source_agent:input.source_agent, destination_agent:input.destination_agent })
  return { ...memory, source_agent:input.source_agent, destination_agent:input.destination_agent, objective:input.objective, relevant_context:input.relevant_context, constraints:input.constraints || null, source_references:refs, expected_result:input.expected_result, status:'pending' }
}

export function updateHandoff(user: User, id: string, status: 'pending'|'in_progress'|'completed'|'cancelled', requestedTenantKey?: string | null) {
  const context = activeContext(user, requestedTenantKey); const db=getDatabase(); const completed=status==='completed'?now():null
  const result=db.prepare('UPDATE working_memory SET handoff_status=?,completed_at=?,updated_at=unixepoch() WHERE memory_id=? AND tenant_id=? AND memory_type=\'handoff\'').run(status,completed,id,context.id); if(!result.changes)throw new Error('Handoff not found for active tenant'); activity(db,context,user.username,'handoff_completed',id,`Handoff ${status}`,{status}); return getMemory(user,id,context.tenantKey)
}

export function listMemory(user: User, query: MemoryQuery, requestedTenantKey?: string | null): PortableMemory[] {
  const context = activeContext(user, requestedTenantKey)
  const db = getDatabase(), clauses = ['wm.tenant_id=?'], params: any[] = [context.id]
  const map: Record<string,string> = { memory_id:'wm.memory_id', project_id:'wm.project_id', agent_id:'wm.agent_id', task_id:'wm.task_id', memory_type:'wm.memory_type', importance:'wm.importance', lifecycle_status:'wm.lifecycle_status', promotion_status:'wm.promotion_status', source:'wm.source' }
  for (const key of Object.keys(map)) if (query[key as keyof MemoryQuery] !== undefined) { clauses.push(`${map[key]}=?`); params.push(key.endsWith('_id') && key !== 'memory_id' ? Number(query[key as keyof MemoryQuery]) : query[key as keyof MemoryQuery]) }
  if (query.recency_since !== undefined) { clauses.push('wm.updated_at>=?'); params.push(query.recency_since) }
  const limit = Math.min(Math.max(query.limit || 50, 1), MAX_LIMIT), offset = Math.max(query.offset || 0, 0)
  const rows = db.prepare(`SELECT wm.*, t.tenant_key, CAST(wm.project_id AS TEXT) as project_key, CAST(wm.agent_id AS TEXT) as agent_key, CAST(wm.task_id AS TEXT) as task_key FROM working_memory wm JOIN tenants t ON t.id=wm.tenant_id WHERE ${clauses.join(' AND ')} ORDER BY wm.updated_at DESC, wm.memory_id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[]
  return rows.map(parseRow)
}
export function getMemory(user: User, id: string, requestedTenantKey?: string | null) { const rows = listMemory(user, { memory_id: id, limit: 1 }, requestedTenantKey); return rows[0] || null }
export function updateMemory(user: User, id: string, updates: Partial<Pick<PortableMemory,'lifecycle_status'|'promotion_status'|'durable_reference'>>, requestedTenantKey?: string | null) {
  const context = activeContext(user, requestedTenantKey); rejectSecrets(updates); const db=getDatabase(); const result=db.prepare('UPDATE working_memory SET lifecycle_status=COALESCE(?,lifecycle_status), promotion_status=COALESCE(?,promotion_status), durable_reference=COALESCE(?,durable_reference), updated_at=unixepoch() WHERE memory_id=? AND tenant_id=?').run(updates.lifecycle_status||null,updates.promotion_status||null,updates.durable_reference||null,id,context.id); if (!result.changes) throw new Error('Memory not found for active tenant'); activity(db, context, user.username, 'memory_updated', id, 'Working memory updated', updates); return getMemory(user,id,context.tenantKey)
}
