import { randomUUID } from 'node:crypto'
import { getDatabase, db_helpers, logAuditEvent } from './db'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { readAuthorityShadowState } from './authority/state'
import { buildHermesProjectContext, bindingForSession, createHermesTask, saveHermesMemory } from './hermes-coo'
import { sendHermesBackgroundMessage } from './hermes-runtime'
import { resolveEffectiveModel, type EffectiveModel } from './model-profiles'
import { fetchPublicJsonApi, fetchPublicUrl, recordResearchFailure, researchChecklist, researchCounts, saveHermesEvidence, searchPublicWeb, HERMES_RESEARCH_LIMITS } from './hermes-research'
import type { User } from './auth'

export const HERMES_BACKGROUND_LIMITS = {
  maxActivePerTenant: 1,
  maxActivePerAgent: 1,
  maxNewClaimsPerTick: 1,
  maxActionsPerRun: 32,
  maxAttempts: 3,
  maxRunSeconds: 10 * 60,
  staleAfterSeconds: 2 * 60,
} as const

export type HermesRunStatus = 'QUEUED' | 'RUNNING' | 'WAITING_FOR_CEO' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'

export function resolveHermesBackgroundState(input: {
  paused: boolean
  activeStatus?: HermesRunStatus | null
  hasCurrentFailure: boolean
  hasCurrentBlock: boolean
}) {
  if (input.paused) return 'PAUSED'
  if (input.activeStatus === 'WAITING_FOR_CEO') return 'WAITING FOR CEO'
  if (input.activeStatus === 'RUNNING') return 'WORKING'
  if (input.hasCurrentFailure) return 'ERROR'
  if (input.hasCurrentBlock) return 'BLOCKED'
  return 'IDLE'
}

class ApprovalRequested extends Error {
  constructor(public readonly approvalId: string) { super('CEO approval requested') }
}

function now() { return Math.floor(Date.now() / 1000) }

function isPaused() {
  return readAuthorityShadowState().dispatch_mode === 'PAUSED'
}

function parseMetadata(raw: string | null | undefined): Record<string, any> {
  try { return raw ? JSON.parse(raw) : {} } catch { return {} }
}

function backgroundUser(tenantId: number, workspaceId: number): User {
  return {
    id: 0, username: 'Hermes', display_name: 'Hermes COO', role: 'operator',
    workspace_id: workspaceId, tenant_id: tenantId, provider: 'local', email: null,
    avatar_url: null, is_approved: 1, created_at: 0, updated_at: now(), last_login_at: null,
  }
}

function tenantModel(tenantId: number, agentId: number, db = getDatabase()): EffectiveModel | null {
  const tenant = db.prepare('SELECT id, tenant_key, slug, display_name, status FROM tenants WHERE id = ?').get(tenantId) as any
  if (!tenant || tenant.status === 'decommissioned') return null
  return resolveEffectiveModel({ id: tenant.id, tenantKey: tenant.tenant_key, slug: tenant.slug, displayName: tenant.display_name, status: tenant.status, membershipRole: 'owner', userId: 0 }, { agentId, purpose: 'task' }, db)
    || resolveEffectiveModel({ id: tenant.id, tenantKey: tenant.tenant_key, slug: tenant.slug, displayName: tenant.display_name, status: tenant.status, membershipRole: 'owner', userId: 0 }, { agentId, purpose: 'general' }, db)
}

function updateRun(runId: string, fields: Record<string, unknown>) {
  const db = getDatabase()
  const allowed = new Set(['status', 'heartbeat_at', 'completed_at', 'provider_id', 'model_id', 'model_profile_id', 'input_tokens', 'output_tokens', 'cost_usd', 'last_meaningful_activity', 'stop_reason', 'error_classification', 'approval_id', 'action_count', 'research_stage', 'research_iterations', 'research_source_count', 'evidence_count'])
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key))
  if (!entries.length) return
  db.prepare(`UPDATE hermes_coo_runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE run_id = ?`).run(...entries.map(([, value]) => value), runId)
  const row = db.prepare('SELECT workspace_id FROM hermes_coo_runs WHERE run_id = ?').get(runId) as { workspace_id?: number } | undefined
  eventBus.broadcast('run.updated', { run_id: runId, ...fields, workspace_id: Number(row?.workspace_id || 0) })
}

function audit(runId: string, action: string, detail: Record<string, unknown>, workspaceId: number, tenantId: number) {
  logAuditEvent({ action, actor: 'Hermes', target_type: 'hermes_coo_run', detail: { run_id: runId, ...detail }, workspace_id: workspaceId, tenant_id: tenantId })
}

export function updateHermesTaskStatus(db: Pick<ReturnType<typeof getDatabase>, 'prepare'>, taskId: number, workspaceId: number, status: string, resolution?: string, timestamp = now()) {
  db.prepare(`UPDATE tasks
    SET status = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE completed_at END,
        resolution = COALESCE(?, resolution),
        outcome = CASE WHEN ? IS NULL THEN outcome ELSE 'success' END
    WHERE id = ? AND workspace_id = ?`)
    .run(status, timestamp, status, timestamp, resolution || null, resolution || null, taskId, workspaceId)
}

function markTask(db: ReturnType<typeof getDatabase>, taskId: number, workspaceId: number, status: string, detail: string, resolution?: string) {
  const timestamp = now()
  updateHermesTaskStatus(db, taskId, workspaceId, status, resolution, timestamp)
  eventBus.broadcast('task.status_changed', { id: taskId, status, workspace_id: workspaceId })
  db_helpers.logActivity('hermes_background_task', 'task', taskId, 'Hermes', detail, { status }, workspaceId)
}

function requiresResearch(task: any) { return /research|evidence|citation|source|api|feasibility|licen[cs]e|url/i.test(`${task.title} ${task.description}`) }
function meetsResearchCriteria(task: any, result: string, counts: { source_count: number; evidence_count: number }, runId = '') {
  if (!requiresResearch(task)) return true
  const lower = result.toLowerCase()
  const task14 = task.id === 14 || /quebec price data feasibility/i.test(task.title)
  if (task14) {
    const checklist = researchChecklist({ tenantId: task.tenant_id, workspaceId: task.workspace_id, taskId: task.id, runId })
    return counts.evidence_count >= 6 && counts.source_count >= 6 && ['epiceries.ca', 'api', 'schema', 'matrix', 'commercial'].every((term) => lower.includes(term)) && Object.values(checklist).every(Boolean)
  }
  return counts.evidence_count > 0 && /https?:\/\//i.test(result)
}

async function executeClaim(task: any): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const runId = randomUUID()
  const correlationId = `hermes-coo:${task.id}:${runId}`
  const start = now()
  const model = tenantModel(task.tenant_id, task.agent_id, db)
  if (!model) {
    markTask(db, task.id, task.workspace_id, 'blocked', 'Hermes background task blocked: no approved model profile')
    return { ok: false, message: `Task ${task.id} blocked: no approved Hermes model profile` }
  }

  db.prepare(`INSERT INTO hermes_coo_runs (run_id,tenant_id,workspace_id,project_id,task_id,agent_id,status,started_at,heartbeat_at,attempt,model_profile_id,provider_id,model_id,last_meaningful_activity,correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, task.tenant_id, task.workspace_id, task.project_id, task.id, task.agent_id, 'RUNNING', start, start, Number(task.dispatch_attempts || 0) + 1, model.profile_id, model.provider_id, model.model_id, 'Run claimed by Mission Control scheduler', correlationId)
  audit(runId, 'hermes.background_run_started', { task_id: task.id, project_id: task.project_id, provider: model.provider_id, model: model.model_id }, task.workspace_id, task.tenant_id)

  const user = backgroundUser(task.tenant_id, task.workspace_id)
  const sessionId = `mc_${task.tenant_id}_${task.workspace_id}_${task.agent_id}_${task.project_id}_bg_${runId.replaceAll('-', '')}`
  const binding = { tenantId: task.tenant_id, workspaceId: task.workspace_id, agentId: task.agent_id, projectId: task.project_id, sessionId }
  let actionCount = 0
  let researchSearches = 0
  let researchFetches = 0
  let approvalId: string | null = null
  const heartbeat = (activity: string) => updateRun(runId, { heartbeat_at: now(), last_meaningful_activity: activity })

  try {
    const context = await buildHermesProjectContext(user, task.project_id)
    const metadata = parseMetadata(task.metadata)
    const research = requiresResearch(task)
    const systemMessage = `Mission Control background COO execution. You are operating only on the server-authorized tenant ${task.tenant_id}, project ${task.project_id}, task ${task.id}. No shell, PTY, process spawn, credentials, filesystem mutation, financial action, deployment, or architecture change is available. ${research ? `This is an evidence-first research task. You MUST perform research before writing prose. Available exact action envelopes are: <mc_action>{"action":"SEARCH_WEB","parameters":{"query":"..."}}</mc_action>, <mc_action>{"action":"FETCH_PUBLIC_URL","parameters":{"url":"https://..."}}</mc_action>, <mc_action>{"action":"FETCH_PUBLIC_JSON_API","parameters":{"url":"https://..."}}</mc_action>, and <mc_action>{"action":"SAVE_RESEARCH_EVIDENCE","parameters":{"url":"https://...","title":"...","claim":"...","summary":"...","classification":"VERIFIED|INFERRED|UNVERIFIED|CONFLICTING","confidence":"high|medium|low"}}</mc_action>. Emit one or more of these exact actions now, then continue after tool results. Inspect sources, preserve exact URLs, dates and evidence, and label each material claim VERIFIED, INFERRED, UNVERIFIED, or CONFLICTING. Do not invent access, legal, licensing, or commercial conclusions. Required outputs must cite saved evidence.` : ''} You may emit only these bounded actions: SAVE_WORKING_MEMORY, CREATE_TASK (must be assigned to yourself), UPDATE_TASK_RESULT (current task only), REQUEST_CEO_APPROVAL, SEARCH_WEB, FETCH_PUBLIC_URL, FETCH_PUBLIC_JSON_API, SAVE_RESEARCH_EVIDENCE. Do not create follow-up tasks unless strictly required by the task and never create more than one. Project context: ${JSON.stringify(context)}\nTask: ${JSON.stringify({ id: task.id, title: task.title, description: task.description, priority: task.priority })}`
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      sendHermesBackgroundMessage({
        tenantId: task.tenant_id, workspaceId: task.workspace_id, agentId: task.agent_id, projectId: task.project_id,
        sessionId, message: `Execute the bounded task. Work only within the supplied context. Save useful working memory when appropriate, write a concise result, and use UPDATE_TASK_RESULT for the current task when finished.`,
        systemMessage, provider: model.provider_id, model: model.model_id, onHeartbeat: heartbeat,
        researchRequired: research, maxIterations: HERMES_RESEARCH_LIMITS.maxIterations,
        onAction: async (action) => {
          if (isPaused()) throw new Error('Mission Control is PAUSED')
          actionCount += 1
          updateRun(runId, { action_count: actionCount, heartbeat_at: now(), last_meaningful_activity: `Bounded action ${action.action}` })
          if (actionCount > HERMES_BACKGROUND_LIMITS.maxActionsPerRun) throw new Error('Hermes action limit exceeded')
          const params = action.parameters || {}
          if (action.action === 'SAVE_WORKING_MEMORY') {
            return saveHermesMemory(user, binding, { title: String(params.title || '').slice(0, 240), content: String(params.content || '').slice(0, 20000), memory_type: (params.memory_type === 'current_state' || params.memory_type === 'product_context' || params.memory_type === 'operational_note') ? params.memory_type : 'operational_note' })
          }
          if (action.action === 'SEARCH_WEB') {
            researchSearches += 1
            if (researchSearches > HERMES_RESEARCH_LIMITS.maxSearches) throw new Error('Hermes research search limit exceeded')
            updateRun(runId, { research_stage: 'SEARCH', heartbeat_at: now() })
            try { return await searchPublicWeb(String(params.query || ''), { tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id, runId }) }
            catch (error) { return { error: String(error instanceof Error ? error.message : error).slice(0, 300), query: String(params.query || '') } }
          }
          if (action.action === 'FETCH_PUBLIC_URL' || action.action === 'FETCH_PUBLIC_JSON_API') {
            researchFetches += 1
            if (researchFetches > HERMES_RESEARCH_LIMITS.maxFetches) throw new Error('Hermes research fetch limit exceeded')
            updateRun(runId, { research_stage: 'FETCH', heartbeat_at: now() })
            const scope = { tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id, runId }
            try { return action.action === 'FETCH_PUBLIC_JSON_API' ? await fetchPublicJsonApi(String(params.url || ''), scope) : await fetchPublicUrl(String(params.url || ''), scope) }
            catch (error) { const message = String(error instanceof Error ? error.message : error).slice(0, 300); const sourceId = recordResearchFailure(scope, String(params.url || ''), message); return { error: message, source_id: sourceId, url: String(params.url || '') } }
          }
          if (action.action === 'SAVE_RESEARCH_EVIDENCE') {
            updateRun(runId, { research_stage: 'ASSESS', heartbeat_at: now() })
            return saveHermesEvidence({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id, runId }, {
              url: String(params.url || ''), title: String(params.title || ''), publisher: String(params.publisher || ''), claim: String(params.claim || ''), summary: String(params.summary || params.evidence_summary || ''), quote: typeof params.quote === 'string' ? params.quote : undefined, entity: typeof params.entity === 'string' ? params.entity : undefined,
              confidence: ['high', 'medium', 'low'].includes(String(params.confidence)) ? params.confidence as any : 'low', classification: ['VERIFIED', 'INFERRED', 'UNVERIFIED', 'CONFLICTING'].includes(String(params.classification)) ? params.classification as any : 'UNVERIFIED',
            })
          }
          if (action.action === 'CREATE_TASK') {
            const input: any = { title: params.title, objective: params.objective, acceptance_criteria: Array.isArray(params.acceptance_criteria) ? params.acceptance_criteria : [], priority: params.priority || 'low', dependencies: Array.isArray(params.dependencies) ? params.dependencies : [], assignee: task.agent_name, labels: ['hermes-background'] }
            if (params.assignee && String(params.assignee).toLowerCase() !== task.agent_name.toLowerCase()) throw new Error('Hermes background tasks may only self-assign bounded follow-ups')
            const created = createHermesTask(user, binding, input) as any
            if (!created.idempotent) db.prepare("UPDATE tasks SET status = 'assigned', metadata = json_set(COALESCE(metadata, '{}'), '$.hermes_autonomous', true), updated_at = unixepoch() WHERE id = ? AND workspace_id = ?").run(created.id, task.workspace_id)
            return created
          }
          if (action.action === 'REQUEST_CEO_APPROVAL') {
            const reason = String(params.reason || params.question || '').trim().slice(0, 2000)
            if (!reason) throw new Error('CEO approval reason is required')
            approvalId = randomUUID()
            db.prepare('INSERT INTO hermes_coo_approvals (approval_id,tenant_id,workspace_id,project_id,task_id,run_id,reason,requested_action) VALUES (?,?,?,?,?,?,?,?)')
              .run(approvalId, task.tenant_id, task.workspace_id, task.project_id, task.id, runId, reason, String(params.requested_action || 'CEO decision').slice(0, 500))
            markTask(db, task.id, task.workspace_id, 'awaiting_owner', `Hermes is waiting for CEO approval: ${reason}`)
            updateRun(runId, { status: 'WAITING_FOR_CEO', approval_id: approvalId, stop_reason: 'CEO approval required', heartbeat_at: now(), last_meaningful_activity: 'CEO approval requested' })
            audit(runId, 'hermes.background_approval_requested', { approval_id: approvalId, reason }, task.workspace_id, task.tenant_id)
            throw new ApprovalRequested(approvalId)
          }
          if (action.action === 'UPDATE_TASK_RESULT') {
            if (Number(params.task_id) !== task.id) throw new Error('Hermes may update only the current task')
            const resultText = String(params.result || params.resolution || '').trim().slice(0, 10000)
            if (!resultText) throw new Error('Task result is required')
            const counts = researchCounts({ tenantId: task.tenant_id, workspaceId: task.workspace_id, taskId: task.id, runId })
            if (!meetsResearchCriteria(task, resultText, counts, runId)) return { task_id: task.id, status: 'in_progress', completion_rejected: true, reason: 'Required evidence-backed deliverables are incomplete', ...counts }
            const requested = String(params.status || 'review')
            const status = requested === 'done' && parseMetadata(task.metadata).hermes_autonomous_completion === true ? 'done' : requested === 'blocked' ? 'blocked' : requested === 'awaiting_owner' ? 'awaiting_owner' : 'review'
            db.prepare('INSERT INTO comments (task_id,author,content,created_at,workspace_id) VALUES (?,?,?,?,?)').run(task.id, task.agent_name, resultText, now(), task.workspace_id)
            markTask(db, task.id, task.workspace_id, status, `Hermes wrote a bounded task result`, resultText)
            return { task_id: task.id, status }
          }
          throw new Error(`Unsupported Hermes background action: ${action.action}`)
        },
      }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Hermes background run timed out')), HERMES_BACKGROUND_LIMITS.maxRunSeconds * 1000) }),
    ]).finally(() => { if (timeout) clearTimeout(timeout) })
    const response = result as any
    const resolution = response.response.slice(0, 10000)
    const counts = researchCounts({ tenantId: task.tenant_id, workspaceId: task.workspace_id, taskId: task.id, runId })
    const current = db.prepare('SELECT status, resolution FROM tasks WHERE id = ? AND workspace_id = ?').get(task.id, task.workspace_id) as any
    if (current.status === 'in_progress' && research && !meetsResearchCriteria(task, resolution, counts, runId)) {
      markTask(db, task.id, task.workspace_id, 'blocked', 'Hermes blocked: evidence-first completion criteria were not met', `Research blocked: ${counts.evidence_count} evidence items and ${counts.source_count} sources persisted; required deliverables remain incomplete.`)
    } else if (current.status === 'in_progress') {
      db.prepare('INSERT INTO comments (task_id,author,content,created_at,workspace_id) VALUES (?,?,?,?,?)').run(task.id, task.agent_name, resolution, now(), task.workspace_id)
      markTask(db, task.id, task.workspace_id, 'review', 'Hermes completed reasoning; task awaits review', resolution)
    }
    updateRun(runId, { status: 'SUCCEEDED', completed_at: now(), heartbeat_at: now(), input_tokens: response.inputTokens || 0, output_tokens: response.outputTokens || 0, research_stage: 'VALIDATE', research_iterations: response.iterations || 1, research_source_count: counts.source_count, evidence_count: counts.evidence_count, stop_reason: 'bounded_execution_completed', last_meaningful_activity: 'Hermes background execution completed' })
    audit(runId, 'hermes.background_run_succeeded', { task_id: task.id, action_count: actionCount }, task.workspace_id, task.tenant_id)
    return { ok: true, message: `Hermes completed task ${task.id}` }
  } catch (error: any) {
    if (error instanceof ApprovalRequested) return { ok: true, message: `Task ${task.id} is waiting for CEO approval (${approvalId})` }
    const classification = error?.message === 'Mission Control is PAUSED' ? 'paused' : error?.message?.includes('timed out') ? 'timeout' : 'provider_or_runtime_error'
    const status = classification === 'paused' ? 'INTERRUPTED' : 'FAILED'
    const taskStatus = classification === 'paused' ? 'assigned' : 'blocked'
    markTask(db, task.id, task.workspace_id, taskStatus, `Hermes background execution ${status.toLowerCase()}: ${String(error?.message || error).slice(0, 500)}`)
    updateRun(runId, { status, completed_at: now(), heartbeat_at: now(), stop_reason: String(error?.message || error).slice(0, 500), error_classification: classification, last_meaningful_activity: `Hermes background execution ${status.toLowerCase()}` })
    audit(runId, 'hermes.background_run_failed', { task_id: task.id, classification, error: String(error?.message || error).slice(0, 500) }, task.workspace_id, task.tenant_id)
    logger.warn({ runId, taskId: task.id, error }, 'Hermes background COO run failed')
    return { ok: false, message: `Hermes task ${task.id} ${status.toLowerCase()}: ${String(error?.message || error)}` }
  }
}

export async function runHermesBackgroundTick(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const timestamp = now()
  const stale = db.prepare("SELECT run_id, task_id, workspace_id, tenant_id FROM hermes_coo_runs WHERE status = 'RUNNING' AND heartbeat_at < ?").all(timestamp - HERMES_BACKGROUND_LIMITS.staleAfterSeconds) as any[]
  for (const run of stale) {
    updateRun(run.run_id, { status: 'INTERRUPTED', completed_at: timestamp, stop_reason: 'stale heartbeat after Mission Control restart', error_classification: 'interrupted', last_meaningful_activity: 'Run interrupted during restart recovery' })
    db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ?, error_message = ? WHERE id = ? AND workspace_id = ? AND status = 'in_progress'").run(timestamp, 'Hermes run interrupted after stale heartbeat; manual retry required', run.task_id, run.workspace_id)
    audit(run.run_id, 'hermes.background_run_interrupted', { task_id: run.task_id }, run.workspace_id, run.tenant_id)
  }
  if (isPaused()) return { ok: true, message: 'Hermes background dispatch paused' }
  const task = db.prepare(`SELECT t.*, a.id agent_id, a.name agent_name, a.runtime_type, w.tenant_id
    FROM tasks t JOIN agents a ON lower(a.name) = lower(t.assigned_to) AND a.workspace_id = t.workspace_id
    JOIN workspaces w ON w.id = t.workspace_id
    JOIN tenants tenant ON tenant.id = w.tenant_id AND tenant.status = 'active'
    JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id AND p.status = 'active'
    WHERE t.status = 'assigned' AND lower(t.assigned_to) = 'hermes' AND lower(a.runtime_type) = 'hermes'
      AND json_extract(COALESCE(t.metadata, '{}'), '$.hermes_autonomous') = 1
      AND EXISTS (SELECT 1 FROM project_agent_assignments paa WHERE paa.project_id = t.project_id AND lower(paa.agent_name) = 'hermes')
      AND t.dispatch_attempts < ?
      AND NOT EXISTS (SELECT 1 FROM hermes_coo_runs r WHERE r.tenant_id = w.tenant_id AND r.status IN ('QUEUED','RUNNING','WAITING_FOR_CEO'))
    ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC LIMIT 1`).get(HERMES_BACKGROUND_LIMITS.maxAttempts) as any
  if (!task) return { ok: true, message: 'No eligible Hermes background task' }
  const claim = db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'assigned' AND workspace_id = ?").run(timestamp, task.id, task.workspace_id)
  if (claim.changes !== 1) return { ok: true, message: 'Hermes task claim lost race' }
  eventBus.broadcast('task.status_changed', { id: task.id, status: 'in_progress', previous_status: 'assigned', workspace_id: task.workspace_id })
  return executeClaim(task)
}

export function getHermesBackgroundStatus(workspaceId?: number) {
  const db = getDatabase()
  const where = workspaceId ? 'AND workspace_id = ?' : ''
  const params = workspaceId ? [workspaceId] : []
  const active = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM hermes_research_sources s WHERE s.run_id=r.run_id AND s.tenant_id=r.tenant_id) AS research_source_count, (SELECT COUNT(*) FROM hermes_research_evidence e WHERE e.run_id=r.run_id AND e.tenant_id=r.tenant_id) AS evidence_count FROM hermes_coo_runs r WHERE r.status IN ('QUEUED','RUNNING','WAITING_FOR_CEO') ${where.replaceAll('workspace_id', 'r.workspace_id')} ORDER BY r.started_at DESC LIMIT 1`).get(...params) as any
  const next = db.prepare(`SELECT id,title,project_id,status,assigned_to,created_at FROM tasks WHERE status = 'assigned' AND lower(assigned_to) = 'hermes' AND json_extract(COALESCE(metadata, '{}'), '$.hermes_autonomous') = 1 ${workspaceId ? 'AND workspace_id = ?' : ''} ORDER BY created_at LIMIT 1`).get(...params) as any
  const completedToday = db.prepare(`SELECT COUNT(*) c FROM hermes_coo_runs WHERE status = 'SUCCEEDED' AND completed_at >= unixepoch('start of day') ${workspaceId ? 'AND workspace_id = ?' : ''}`).get(...params) as any
  const blocked = db.prepare(`SELECT id,title,status,project_id,updated_at,error_message FROM tasks WHERE status IN ('blocked','awaiting_owner') ${workspaceId ? 'AND workspace_id = ?' : ''} AND (lower(assigned_to) = 'hermes' OR json_extract(COALESCE(metadata, '{}'), '$.hermes_autonomous') = 1) ORDER BY updated_at DESC LIMIT 20`).all(...params)
  const approvals = db.prepare(`SELECT * FROM hermes_coo_approvals WHERE status = 'PENDING' ${workspaceId ? 'AND workspace_id = ?' : ''} ORDER BY requested_at DESC LIMIT 20`).all(...params)
  const recentFailure = db.prepare(`SELECT run_id,status,task_id,project_id,completed_at,last_meaningful_activity,stop_reason,error_classification,provider_id,model_id
    FROM hermes_coo_runs WHERE status IN ('FAILED','INTERRUPTED') ${workspaceId ? 'AND workspace_id = ?' : ''} ORDER BY completed_at DESC LIMIT 1`).get(...params) as any
  const currentFailure = db.prepare(`SELECT failed.run_id
    FROM hermes_coo_runs failed
    WHERE failed.status IN ('FAILED','INTERRUPTED')
      ${workspaceId ? 'AND failed.workspace_id = ?' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM hermes_coo_runs recovered
        WHERE recovered.task_id = failed.task_id
          AND recovered.status = 'SUCCEEDED'
          AND recovered.started_at > failed.started_at
      )
    ORDER BY failed.completed_at DESC LIMIT 1`).get(...params) as any
  const recentOutputs = db.prepare(`SELECT c.task_id,c.author,c.content,c.created_at FROM comments c JOIN tasks t ON t.id=c.task_id AND t.workspace_id=c.workspace_id WHERE c.author = 'Hermes' ${workspaceId ? 'AND c.workspace_id = ?' : ''} ORDER BY c.created_at DESC LIMIT 10`).all(...params)
  const paused = isPaused()
  return { paused, state: resolveHermesBackgroundState({ paused, activeStatus: active?.status || null, hasCurrentFailure: Boolean(currentFailure), hasCurrentBlock: blocked.length > 0 }), current: active || null, next, completed_today: completedToday?.c || 0, blocked, approvals, recent_failure: recentFailure || null, recent_outputs: recentOutputs }
}

export function decideHermesApproval(approvalId: string, decision: 'APPROVED' | 'REJECTED', actor: string, note = '', workspaceId?: number) {
  const db = getDatabase()
  const approval = db.prepare(`SELECT * FROM hermes_coo_approvals WHERE approval_id = ? AND status = 'PENDING' ${workspaceId ? 'AND workspace_id = ?' : ''}`).get(...(workspaceId ? [approvalId, workspaceId] : [approvalId])) as any
  if (!approval) throw new Error('Pending Hermes approval not found')
  const timestamp = now()
  db.transaction(() => {
    db.prepare('UPDATE hermes_coo_approvals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE approval_id = ? AND status = \'PENDING\'').run(decision, timestamp, actor, note.slice(0, 2000), approvalId)
    if (decision === 'APPROVED') {
      db.prepare("UPDATE hermes_coo_runs SET status = 'INTERRUPTED', stop_reason = 'CEO approved; a fresh bounded run is required', heartbeat_at = ? WHERE run_id = ? AND status = 'WAITING_FOR_CEO'").run(timestamp, approval.run_id)
      db.prepare("UPDATE tasks SET status = 'assigned', updated_at = ?, error_message = NULL WHERE id = ? AND workspace_id = ? AND status = 'awaiting_owner'").run(timestamp, approval.task_id, approval.workspace_id)
    } else {
      db.prepare("UPDATE hermes_coo_runs SET status = 'CANCELLED', completed_at = ?, stop_reason = 'CEO rejected request' WHERE run_id = ? AND status = 'WAITING_FOR_CEO'").run(timestamp, approval.run_id)
      db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ?, error_message = ? WHERE id = ? AND workspace_id = ? AND status = 'awaiting_owner'").run(timestamp, 'CEO rejected Hermes approval request', approval.task_id, approval.workspace_id)
    }
  })()
  logAuditEvent({ action: `hermes.background_approval_${decision.toLowerCase()}`, actor, target_type: 'hermes_coo_approval', detail: { approval_id: approvalId, run_id: approval.run_id, task_id: approval.task_id }, workspace_id: approval.workspace_id, tenant_id: approval.tenant_id })
  return { approval_id: approvalId, status: decision, task_id: approval.task_id, run_id: approval.run_id }
}
