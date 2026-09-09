import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { User } from '@/lib/auth'
import { getDatabase, db_helpers, logAuditEvent } from '@/lib/db'
import { config } from '@/lib/config'
import { newMemoryId, MEMORY_SCHEMA_VERSION, portableMemorySchema, rejectSecrets } from '@/lib/portable-memory'
import { ensureTenantProjectAccess } from '@/lib/workspaces'
import { readDocsContent } from '@/lib/docs-knowledge'

const MASTER_PLAN = 'knowledge/quebec-grocery-intelligence-master-plan.md'
const MAX_KNOWLEDGE_BYTES = 120_000

export const hermesCreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(5_000),
  acceptance_criteria: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  dependencies: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  assignee: z.string().trim().min(1).max(100).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
}).strict()

export type HermesBinding = { tenantId: number; workspaceId: number; agentId: number; projectId: number; sessionId: string }

export function resolveHermesProject(user: User, projectId: number): { id: number; name: string; slug: string; description: string | null } {
  const db = getDatabase()
  ensureTenantProjectAccess(db, user.tenant_id, projectId, { actor: user.username, actorId: user.id, route: '/api/agents/message' })
  const project = db.prepare(`SELECT id, name, slug, description FROM projects WHERE id = ? AND workspace_id = ? AND status = 'active'`).get(projectId, user.workspace_id) as { id: number; name: string; slug: string; description: string | null } | undefined
  if (!project) throw new Error('Project context invalid')
  return project
}

async function readMasterPlan(): Promise<{ path: string; content: string } | null> {
  const root = config.memoryDir
  if (!root || !existsSync(join(root, 'knowledge'))) return null
  const path = join(root, MASTER_PLAN)
  if (!existsSync(path)) return null
  const doc = await readDocsContent(MASTER_PLAN)
  return { path: doc.path, content: doc.content.slice(0, MAX_KNOWLEDGE_BYTES) }
}

export async function buildHermesProjectContext(user: User, projectId: number) {
  const project = resolveHermesProject(user, projectId)
  const db = getDatabase()
  const memories = db.prepare(`SELECT memory_id, memory_type, title, content, importance, promotion_status, lifecycle_status, updated_at, metadata FROM working_memory WHERE tenant_id = ? AND project_id = ? AND lifecycle_status = 'active' ORDER BY updated_at DESC, memory_id ASC LIMIT 12`).all(user.tenant_id, project.id) as Array<Record<string, unknown>>
  const currentState = memories.find((m) => m.memory_type === 'current_state') || null
  const relevant = memories.filter((m) => m.memory_type !== 'current_state').slice(0, 8)
  const knowledge = (/quebec[- ]grocery/i.test(project.slug) || /quebec grocery/i.test(project.name)) ? await readMasterPlan() : null
  return {
    project: { id: project.id, name: project.name, slug: project.slug, description: project.description },
    knowledge,
    working_memory: { current_state: currentState, relevant },
    binding: { tenant_id: user.tenant_id, workspace_id: user.workspace_id, project_id: project.id },
  }
}

export function bindingForSession(user: User, sessionId: string): HermesBinding {
  const db = getDatabase()
  const row = db.prepare(`SELECT tenant_id as tenantId, workspace_id as workspaceId, agent_id as agentId, project_id as projectId, hermes_session_id as sessionId FROM hermes_runtime_bindings WHERE tenant_id = ? AND workspace_id = ? AND hermes_session_id = ? AND project_id IS NOT NULL`).get(user.tenant_id, user.workspace_id, sessionId) as HermesBinding | undefined
  if (!row || row.tenantId !== user.tenant_id || row.workspaceId !== user.workspace_id || !row.projectId) throw new Error('Hermes session is not bound to an authorized project')
  return row
}

export function createHermesTask(user: User, binding: HermesBinding, input: z.infer<typeof hermesCreateTaskSchema>) {
  if (binding.tenantId !== user.tenant_id || binding.workspaceId !== user.workspace_id) throw new Error('Hermes binding is outside the active tenant/workspace')
  const db = getDatabase()
  resolveHermesProject(user, binding.projectId)
  if (input.assignee) {
    const exists = db.prepare('SELECT 1 FROM agents WHERE name = ? AND workspace_id = ?').get(input.assignee, binding.workspaceId)
    if (!exists) throw new Error('Assignee is not authorized in this workspace')
  }
  const description = [input.objective, input.acceptance_criteria.length ? `Acceptance criteria:\n- ${input.acceptance_criteria.join('\n- ')}` : '', input.dependencies.length ? `Dependencies: ${input.dependencies.join(', ')}` : ''].filter(Boolean).join('\n\n')
  const actor = 'Hermes'
  const now = Math.floor(Date.now() / 1000)
  const taskId = db.transaction(() => {
    db.prepare('UPDATE projects SET ticket_counter = ticket_counter + 1, updated_at = unixepoch() WHERE id = ? AND workspace_id = ?').run(binding.projectId, binding.workspaceId)
    const ticket = db.prepare('SELECT ticket_counter FROM projects WHERE id = ? AND workspace_id = ?').get(binding.projectId, binding.workspaceId) as { ticket_counter: number } | undefined
    if (!ticket) throw new Error('Project ticket allocation failed')
    const result = db.prepare(`INSERT INTO tasks (title, description, status, priority, project_id, project_ticket_no, assigned_to, created_by, created_at, updated_at, tags, metadata, workspace_id) VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.title, description, input.priority, binding.projectId, ticket.ticket_counter, input.assignee || null, actor, now, now, JSON.stringify(input.labels), JSON.stringify({ source: 'hermes', hermes_session_id: binding.sessionId, dependencies: input.dependencies }), binding.workspaceId)
    return Number(result.lastInsertRowid)
  })()
  db_helpers.logActivity('task_created', 'task', taskId, actor, `Hermes created task: ${input.title}`, { runtime: 'hermes', hermes_session_id: binding.sessionId, tenant_id: binding.tenantId, project_id: binding.projectId }, binding.workspaceId)
  logAuditEvent({ action: 'hermes.create_task', actor, target_type: 'task', target_id: taskId, detail: { tenant_id: binding.tenantId, project_id: binding.projectId, session_id: binding.sessionId }, workspace_id: binding.workspaceId, tenant_id: binding.tenantId })
  return db.prepare('SELECT id, title, description, status, priority, project_id, assigned_to, created_by, created_at, updated_at FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, binding.workspaceId)
}

export function saveHermesMemory(user: User, binding: HermesBinding, input: { title: string; content: string; memory_type: 'current_state' | 'product_context' | 'operational_note' }) {
  if (binding.projectId <= 0) throw new Error('Project binding required')
  rejectSecrets(input)
  const db = getDatabase()
  resolveHermesProject(user, binding.projectId)
  const tenant = db.prepare('SELECT tenant_key FROM tenants WHERE id = ?').get(binding.tenantId) as { tenant_key: string } | undefined
  if (!tenant) throw new Error('Tenant binding is invalid')
  const timestamp = Math.floor(Date.now() / 1000)
  const memory = portableMemorySchema.parse({ memory_id: newMemoryId(), schema_version: MEMORY_SCHEMA_VERSION, tenant_id: tenant.tenant_key, project_id: String(binding.projectId), agent_id: String(binding.agentId), task_id: null, memory_type: input.memory_type, scope: 'project', title: input.title, content: input.content, source: 'hermes', importance: 'normal', lifecycle_status: 'active', promotion_status: 'none', durable_reference: null, created_at: timestamp, updated_at: timestamp, metadata: { hermes_session_id: binding.sessionId } })
  if (input.memory_type === 'current_state') db.prepare("UPDATE working_memory SET lifecycle_status = 'superseded', updated_at = unixepoch() WHERE tenant_id = ? AND project_id = ? AND memory_type = 'current_state' AND lifecycle_status = 'active'").run(binding.tenantId, binding.projectId)
  db.prepare('INSERT INTO working_memory (memory_id,schema_version,tenant_id,project_id,agent_id,task_id,memory_type,scope,title,content,source,importance,lifecycle_status,promotion_status,durable_reference,metadata,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(memory.memory_id, memory.schema_version, binding.tenantId, binding.projectId, binding.agentId, null, memory.memory_type, memory.scope, memory.title, memory.content, memory.source, memory.importance, memory.lifecycle_status, memory.promotion_status, null, JSON.stringify(memory.metadata), timestamp, timestamp, null)
  db_helpers.logActivity('memory_created', 'working_memory', 0, 'Hermes', `Working memory created: ${memory.title}`, { memory_id: memory.memory_id, memory_type: memory.memory_type, tenant_id: binding.tenantId, project_id: binding.projectId, hermes_session_id: binding.sessionId }, binding.workspaceId)
  logAuditEvent({ action: 'hermes.save_working_memory', actor: 'Hermes', target_type: 'working_memory', detail: { memory_id: memory.memory_id, tenant_id: binding.tenantId, project_id: binding.projectId, session_id: binding.sessionId }, workspace_id: binding.workspaceId, tenant_id: binding.tenantId })
  return memory
}

export const HERMES_ACTIONS = ['CREATE_TASK', 'SAVE_WORKING_MEMORY', 'REQUEST_CEO_APPROVAL'] as const
