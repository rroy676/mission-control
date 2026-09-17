import { randomUUID } from 'node:crypto'
import { getDatabase, db_helpers, logAuditEvent } from './db'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { readAuthorityShadowState } from './authority/state'
import { buildHermesProjectContext, buildHermesResearchProjectContext, bindingForSession, createHermesTask, saveHermesMemory } from './hermes-coo'
import { sendHermesBackgroundMessage } from './hermes-runtime'
import { resolveEffectiveModel, type EffectiveModel } from './model-profiles'
import { beginNextResearchRequirement, compactResearchContext, ensureResearchChecklist, fetchPublicJsonApi, fetchPublicUrl, getResearchChecklistState, recordResearchFailure, recoverStaleResearchClaims, recomputeResearchChecklist, researchActionCompatibility, researchChecklist, researchCounts, researchExecutionContract, saveHermesEvidence, searchPublicWeb, HERMES_RESEARCH_LIMITS } from './hermes-research'
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

export const HERMES_CONTINUATION_DEFAULTS = {
  maxAutomaticRuns: 5,
  maxConsecutiveNoProgress: 3,
  maxInputTokens: 100_000,
  maxOutputTokens: 12_000,
  maxSequenceSeconds: 30 * 60,
  retryDelaySeconds: 5,
} as const

export type HermesContinuationState = 'READY' | 'RUNNING' | 'WAITING_RETRY' | 'WAITING_CEO' | 'WAITING_EXTERNAL' | 'REVIEW' | 'COMPLETE' | 'NO_PROGRESS' | 'SYSTEM_ERROR' | 'SECURITY_STOP' | 'BUDGET_STOP' | 'PAUSED'
export type HermesRunOutcome = 'PROGRESS' | 'NO_PROGRESS' | 'RESEARCH_BLOCKED' | 'WAITING_CEO' | 'SYSTEM_ERROR' | 'COMPLETE_OR_REVIEW'

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

function autonomousPermitted(task: any) {
  return parseMetadata(task.metadata).hermes_autonomous === true
}

export function isHermesRunStartEligible(input: {
  taskExists: boolean
  taskStatus: string | null
  autonomous: boolean
  paused: boolean
  activeRun: boolean
  continuationExists: boolean
  continuationEnabled: boolean
  continuationState: string | null
  leaseOwned: boolean
  leaseUntil: number | null
  nextRunAt: number | null
  scheduled: boolean
  timestamp: number
}) {
  if (!input.taskExists || input.taskStatus !== 'in_progress' || !input.autonomous || input.paused || input.activeRun) return false
  if (!input.scheduled) return true
  return input.continuationExists
    && input.continuationEnabled
    && input.continuationState === 'RUNNING'
    && input.leaseOwned
    && input.leaseUntil != null
    && input.leaseUntil >= input.timestamp
    && input.nextRunAt != null
    && input.nextRunAt <= input.timestamp
}

export function isHermesOneShotStartEligible(input: {
  taskExists: boolean
  taskStatus: string | null
  autonomous: boolean
  paused: boolean
  activeRun: boolean
  continuationExists: boolean
  continuationEnabled: boolean
  continuationState: string | null
  leaseOwned: boolean
  leaseUntil: number | null
  automaticRuns: number
  maxAutomaticRuns: number
  cumulativeInputTokens: number
  cumulativeOutputTokens: number
  maxInputTokens: number
  maxOutputTokens: number
  sequenceStartedAt: number | null
  maxSequenceSeconds: number
  timestamp: number
}) {
  if (!input.taskExists || input.taskStatus !== 'in_progress' || !input.autonomous || input.paused || input.activeRun) return false
  if (!input.continuationExists || !input.continuationEnabled || input.continuationState !== 'RUNNING') return false
  if (!input.leaseOwned || input.leaseUntil == null || input.leaseUntil < input.timestamp) return false
  if (input.automaticRuns >= input.maxAutomaticRuns) return false
  if (input.cumulativeInputTokens >= input.maxInputTokens || input.cumulativeOutputTokens >= input.maxOutputTokens) return false
  if (input.sequenceStartedAt != null && input.timestamp - input.sequenceStartedAt >= input.maxSequenceSeconds) return false
  return true
}

export function ensureHermesContinuation(scope: { tenantId: number; workspaceId: number; projectId: number; taskId: number }) {
  const db = getDatabase()
  db.prepare(`INSERT OR IGNORE INTO hermes_coo_continuations
    (task_id,tenant_id,workspace_id,project_id,max_automatic_runs,max_consecutive_no_progress,max_input_tokens,max_output_tokens,max_sequence_seconds)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(scope.taskId, scope.tenantId, scope.workspaceId, scope.projectId,
    HERMES_CONTINUATION_DEFAULTS.maxAutomaticRuns, HERMES_CONTINUATION_DEFAULTS.maxConsecutiveNoProgress,
    HERMES_CONTINUATION_DEFAULTS.maxInputTokens, HERMES_CONTINUATION_DEFAULTS.maxOutputTokens, HERMES_CONTINUATION_DEFAULTS.maxSequenceSeconds)
  return db.prepare('SELECT * FROM hermes_coo_continuations WHERE task_id=? AND tenant_id=? AND workspace_id=? AND project_id=?').get(scope.taskId, scope.tenantId, scope.workspaceId, scope.projectId) as any
}

export function classifyHermesRunOutcome(input: {
  runStatus: HermesRunStatus
  error?: string | null
  taskStatus: string
  beforeSources: number
  afterSources: number
  beforeEvidence: number
  afterEvidence: number
  beforeChecklist?: string
  afterChecklist?: string
}): HermesRunOutcome {
  if (input.runStatus === 'WAITING_FOR_CEO' || input.taskStatus === 'awaiting_owner') return 'WAITING_CEO'
  if (input.taskStatus === 'done' || input.taskStatus === 'review') return 'COMPLETE_OR_REVIEW'
  let checklistProgress = false
  try {
    const before = JSON.parse(input.beforeChecklist || '[]') as Array<{ requirement_id?: string; status?: string }>
    const after = JSON.parse(input.afterChecklist || '[]') as Array<{ requirement_id?: string; status?: string }>
    const beforeStatuses = new Map(before.map((row, index) => [String(row.requirement_id || index), row.status]))
    const afterStatuses = new Map(after.map((row, index) => [String(row.requirement_id || index), row.status]))
    checklistProgress = [...afterStatuses].some(([id, status]) => status === 'SATISFIED' && beforeStatuses.get(id) !== 'SATISFIED')
  } catch {
    checklistProgress = input.beforeChecklist !== input.afterChecklist && input.afterChecklist === 'satisfied'
  }
  const changed = input.afterSources > input.beforeSources || input.afterEvidence > input.beforeEvidence || checklistProgress
  if (changed) return 'PROGRESS'
  // A safely rejected model action is a bounded research no-progress result,
  // not an implementation failure. Infrastructure/provider failures remain errors.
  if (input.error && /evidence is invalid|parameter repair rejected|no progress/i.test(input.error)) return 'NO_PROGRESS'
  if (input.runStatus === 'FAILED' || input.runStatus === 'INTERRUPTED') return input.error === 'Mission Control is PAUSED' ? 'RESEARCH_BLOCKED' : 'SYSTEM_ERROR'
  return 'NO_PROGRESS'
}

function backgroundUser(tenantId: number, workspaceId: number): User {
  return {
    id: 0, username: 'Hermes', display_name: 'Hermes COO', role: 'operator',
    workspace_id: workspaceId, tenant_id: tenantId, provider: 'local', email: null,
    avatar_url: null, is_approved: 1, created_at: 0, updated_at: now(), last_login_at: null,
  }
}

function tenantModel(tenantId: number, agentId: number, researchRequired = false, db = getDatabase()): EffectiveModel | null {
  const tenant = db.prepare('SELECT id, tenant_key, slug, display_name, status FROM tenants WHERE id = ?').get(tenantId) as any
  if (!tenant || tenant.status === 'decommissioned') return null
  const context = { id: tenant.id, tenantKey: tenant.tenant_key, slug: tenant.slug, displayName: tenant.display_name, status: tenant.status, membershipRole: 'owner' as const, userId: 0 }
  return (researchRequired ? resolveEffectiveModel(context, { agentId, purpose: 'research' }, db) : null)
    || resolveEffectiveModel(context, { agentId, purpose: 'task' }, db)
    || resolveEffectiveModel(context, { agentId, purpose: 'general' }, db)
}

function updateRun(runId: string, fields: Record<string, unknown>) {
  const db = getDatabase()
  const allowed = new Set(['status', 'heartbeat_at', 'completed_at', 'provider_id', 'model_id', 'model_profile_id', 'input_tokens', 'output_tokens', 'cost_usd', 'last_meaningful_activity', 'stop_reason', 'error_classification', 'approval_id', 'action_count', 'research_stage', 'research_iterations', 'research_source_count', 'evidence_count', 'model_turn_count', 'repair_count', 'cache_read_tokens', 'cache_write_tokens', 'max_context_chars', 'max_context_estimated_tokens'])
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

export function normalizeHermesTaskResultIdentity(parameters: Record<string, unknown>, canonicalTaskId: number) {
  const supplied = parameters.task_id
  if (supplied === undefined || supplied === null || supplied === '') {
    return { taskId: canonicalTaskId, mismatch: false as const }
  }
  const parsed = Number(supplied)
  if (Number.isInteger(parsed) && parsed === canonicalTaskId) {
    return { taskId: canonicalTaskId, mismatch: false as const }
  }
  return {
    taskId: canonicalTaskId,
    mismatch: true as const,
    suppliedTaskId: String(supplied).slice(0, 120),
  }
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

function continuationAudit(action: string, row: any, extra: Record<string, unknown> = {}) {
  logAuditEvent({ action, actor: 'Mission Control', target_type: 'hermes_coo_continuation', target_id: row.task_id,
    detail: { tenant_id: row.tenant_id, workspace_id: row.workspace_id, project_id: row.project_id, task_id: row.task_id,
      previous_run_id: row.previous_run_id, last_run_id: row.last_run_id, sequence_no: row.sequence_no,
      automatic_runs: row.automatic_runs, consecutive_no_progress: row.consecutive_no_progress,
      cumulative_input_tokens: row.cumulative_input_tokens, cumulative_output_tokens: row.cumulative_output_tokens, ...extra },
    workspace_id: row.workspace_id, tenant_id: row.tenant_id })
}

export function resolveHermesContinuationTokenUsage(inputTokens: number, outputTokens: number, persistedInputTokens = 0, persistedOutputTokens = 0) {
  return {
    inputTokens: inputTokens > 0 ? inputTokens : Math.max(0, Number(persistedInputTokens || 0)),
    outputTokens: outputTokens > 0 ? outputTokens : Math.max(0, Number(persistedOutputTokens || 0)),
  }
}

export function shouldFinalizeHermesContinuation(lastRunId: string | null | undefined, runId: string) {
  return lastRunId !== runId
}

export function finalizeHermesContinuation(task: any, runId: string, outcome: HermesRunOutcome, reason: string, inputTokens: number, outputTokens: number, beforeChecklist: string, afterChecklist: string, oneShot = false) {
  if (!autonomousPermitted(task)) return
  const db = getDatabase()
  const current = ensureHermesContinuation({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id })
  if (!current || !shouldFinalizeHermesContinuation(current.last_run_id, runId)) return
  const persistedRun = db.prepare('SELECT input_tokens, output_tokens FROM hermes_coo_runs WHERE run_id=? AND tenant_id=? AND workspace_id=? AND project_id=? AND task_id=?').get(runId, task.tenant_id, task.workspace_id, task.project_id, task.id) as { input_tokens?: number; output_tokens?: number } | undefined
  const tokenUsage = resolveHermesContinuationTokenUsage(inputTokens, outputTokens, Number(persistedRun?.input_tokens || 0), Number(persistedRun?.output_tokens || 0))
  const effectiveInputTokens = tokenUsage.inputTokens
  const effectiveOutputTokens = tokenUsage.outputTokens
  const timestamp = now()
  const executionEnabled = current.enabled === 1
  const progressed = outcome === 'PROGRESS'
  const noProgress = outcome === 'NO_PROGRESS' || outcome === 'RESEARCH_BLOCKED'
  const noProgressCount = progressed ? 0 : noProgress ? current.consecutive_no_progress + 1 : current.consecutive_no_progress
  const inputTotal = current.cumulative_input_tokens + effectiveInputTokens
  const outputTotal = current.cumulative_output_tokens + effectiveOutputTokens
  const sequenceStarted = current.sequence_started_at || timestamp
  let state: HermesContinuationState = 'SYSTEM_ERROR'
  let nextRunAt: number | null = null
  let stopReason = reason
  if (!executionEnabled) {
    state = 'READY'
    stopReason = 'Disabled by authorized control-plane action'
  } else if (outcome === 'WAITING_CEO') state = 'WAITING_CEO'
  else if (outcome === 'COMPLETE_OR_REVIEW') state = task.status === 'done' ? 'COMPLETE' : 'REVIEW'
  else if (oneShot && outcome === 'PROGRESS') { state = 'READY'; stopReason = 'Bounded one-shot completed; follow-up not scheduled' }
  else if (oneShot && noProgress) { state = 'NO_PROGRESS'; stopReason = 'Bounded one-shot completed without progress; follow-up not scheduled' }
  else if (oneShot && outcome === 'SYSTEM_ERROR') { state = 'SYSTEM_ERROR'; stopReason = reason }
  else if (oneShot && outcome === 'RESEARCH_BLOCKED') { state = 'WAITING_EXTERNAL'; stopReason = reason || 'Research is blocked on unavailable external information' }
  else if (outcome === 'SYSTEM_ERROR' && /timeout|unavailable|429|502|503|504|fetch failed/i.test(reason) && current.automatic_runs < 3) { state = 'WAITING_RETRY'; nextRunAt = timestamp + Math.min(60, 10 * current.automatic_runs); stopReason = 'Transient provider failure; bounded retry scheduled' }
  else if (outcome === 'SYSTEM_ERROR') state = 'SYSTEM_ERROR'
  else if (isPaused()) state = 'PAUSED'
  else if (outcome === 'RESEARCH_BLOCKED') { state = 'WAITING_EXTERNAL'; stopReason = reason || 'Research is blocked on unavailable external information' }
  else if (noProgressCount >= current.max_consecutive_no_progress) { state = 'NO_PROGRESS'; stopReason = 'Consecutive bounded runs made no meaningful progress' }
  else if (current.automatic_runs >= current.max_automatic_runs) { state = 'BUDGET_STOP'; stopReason = 'Automatic run ceiling reached' }
  else if (inputTotal >= current.max_input_tokens || outputTotal >= current.max_output_tokens) { state = 'BUDGET_STOP'; stopReason = 'Continuation token ceiling reached' }
  else if (timestamp - sequenceStarted >= current.max_sequence_seconds) { state = 'BUDGET_STOP'; stopReason = 'Continuation wall-clock ceiling reached' }
  else if (outcome === 'PROGRESS' || outcome === 'NO_PROGRESS') { state = 'WAITING_RETRY'; nextRunAt = timestamp + HERMES_CONTINUATION_DEFAULTS.retryDelaySeconds; stopReason = outcome === 'PROGRESS' ? 'Deterministic progress; next bounded continuation scheduled' : 'Bounded no-progress retry before threshold' }
  else { state = 'WAITING_EXTERNAL'; stopReason = reason || 'Research cannot progress automatically' }
  const updated = { ...current, previous_run_id: current.last_run_id, last_run_id: runId, last_outcome: outcome, continuation_state: state,
    consecutive_no_progress: noProgressCount, cumulative_input_tokens: inputTotal, cumulative_output_tokens: outputTotal,
    sequence_started_at: sequenceStarted, next_run_at: nextRunAt, stop_reason: stopReason }
  const persisted = db.prepare(`UPDATE hermes_coo_continuations SET previous_run_id=?,last_run_id=?,last_outcome=?,continuation_state=?,consecutive_no_progress=?,cumulative_input_tokens=?,cumulative_output_tokens=?,sequence_started_at=?,next_run_at=?,stop_reason=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE task_id=? AND tenant_id=? AND workspace_id=? AND project_id=? AND enabled=?`).run(
    updated.previous_run_id, updated.last_run_id, updated.last_outcome, updated.continuation_state, updated.consecutive_no_progress,
    updated.cumulative_input_tokens, updated.cumulative_output_tokens, updated.sequence_started_at, updated.next_run_at, updated.stop_reason,
    timestamp, task.id, task.tenant_id, task.workspace_id, task.project_id, executionEnabled ? 1 : 0)
  if (persisted.changes === 0) {
    const latest = ensureHermesContinuation({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id })
    if (latest?.enabled !== 0) return
    state = 'READY'
    nextRunAt = null
    stopReason = 'Disabled by authorized control-plane action'
    db.prepare(`UPDATE hermes_coo_continuations SET previous_run_id=?,last_run_id=?,last_outcome=?,continuation_state='READY',consecutive_no_progress=?,cumulative_input_tokens=?,cumulative_output_tokens=?,sequence_started_at=?,next_run_at=NULL,stop_reason=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE task_id=? AND tenant_id=? AND workspace_id=? AND project_id=? AND enabled=0`).run(
      updated.previous_run_id, updated.last_run_id, updated.last_outcome, updated.consecutive_no_progress,
      updated.cumulative_input_tokens, updated.cumulative_output_tokens, updated.sequence_started_at, stopReason,
      timestamp, task.id, task.tenant_id, task.workspace_id, task.project_id)
  }
  const finalRow = ensureHermesContinuation({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id })
  if (state === 'WAITING_RETRY') {
    db.prepare("UPDATE tasks SET status='assigned',updated_at=? WHERE id=? AND workspace_id=? AND status IN ('blocked','in_progress')").run(timestamp, task.id, task.workspace_id)
    if (outcome === 'PROGRESS') continuationAudit('COO_CONTINUATION_PROGRESS', finalRow, { reason: stopReason, next_run_at: nextRunAt })
    continuationAudit('COO_CONTINUATION_SCHEDULED', finalRow, { reason: stopReason, next_run_at: nextRunAt, outcome })
  } else {
    continuationAudit(state === 'BUDGET_STOP' ? 'COO_CONTINUATION_BUDGET_STOP' : state === 'NO_PROGRESS' ? 'COO_CONTINUATION_NO_PROGRESS' : 'COO_CONTINUATION_STOPPED', finalRow, { reason: stopReason, outcome })
  }
}

function createHermesRunIfEligible(task: any, model: EffectiveModel, leaseId: string | null, oneShot = false) {
  const db = getDatabase()
  const timestamp = now()
  return db.transaction(() => {
    const freshTask = db.prepare('SELECT t.*, w.tenant_id FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=? AND t.workspace_id=?').get(task.id, task.workspace_id) as any
    const continuation = leaseId
      ? db.prepare('SELECT * FROM hermes_coo_continuations WHERE task_id=? AND tenant_id=? AND workspace_id=? AND project_id=?').get(task.id, task.tenant_id, task.workspace_id, task.project_id) as any
      : null
    const activeRun = Boolean(db.prepare("SELECT 1 FROM hermes_coo_runs WHERE tenant_id=? AND workspace_id=? AND status IN ('QUEUED','RUNNING','WAITING_FOR_CEO') LIMIT 1").get(task.tenant_id, task.workspace_id))
    const eligible = oneShot ? isHermesOneShotStartEligible({
      taskExists: Boolean(freshTask), taskStatus: freshTask?.status || null,
      autonomous: Boolean(freshTask && autonomousPermitted(freshTask)), paused: isPaused(), activeRun,
      continuationExists: Boolean(continuation), continuationEnabled: continuation?.enabled === 1,
      continuationState: continuation?.continuation_state || null, leaseOwned: continuation?.lease_id === leaseId,
      leaseUntil: continuation?.lease_until ?? null, automaticRuns: Number(continuation?.automatic_runs || 0),
      maxAutomaticRuns: Number(continuation?.max_automatic_runs || HERMES_CONTINUATION_DEFAULTS.maxAutomaticRuns),
      cumulativeInputTokens: Number(continuation?.cumulative_input_tokens || 0), cumulativeOutputTokens: Number(continuation?.cumulative_output_tokens || 0),
      maxInputTokens: Number(continuation?.max_input_tokens || HERMES_CONTINUATION_DEFAULTS.maxInputTokens), maxOutputTokens: Number(continuation?.max_output_tokens || HERMES_CONTINUATION_DEFAULTS.maxOutputTokens),
      sequenceStartedAt: continuation?.sequence_started_at ?? null, maxSequenceSeconds: Number(continuation?.max_sequence_seconds || HERMES_CONTINUATION_DEFAULTS.maxSequenceSeconds), timestamp,
    }) : isHermesRunStartEligible({
      taskExists: Boolean(freshTask),
      taskStatus: freshTask?.status || null,
      autonomous: Boolean(freshTask && autonomousPermitted(freshTask)),
      paused: isPaused(),
      activeRun,
      continuationExists: Boolean(continuation),
      continuationEnabled: continuation?.enabled === 1,
      continuationState: continuation?.continuation_state || null,
      leaseOwned: continuation?.lease_id === leaseId,
      leaseUntil: continuation?.lease_until ?? null,
      nextRunAt: continuation?.next_run_at ?? null,
      scheduled: Boolean(leaseId),
      timestamp,
    })
    if (!eligible) {
      if (leaseId) db.prepare("UPDATE hermes_coo_continuations SET lease_id=NULL,lease_until=NULL,continuation_state=CASE WHEN enabled=1 THEN 'READY' ELSE 'READY' END,updated_at=? WHERE task_id=? AND tenant_id=? AND workspace_id=? AND project_id=? AND lease_id=?").run(timestamp, task.id, task.tenant_id, task.workspace_id, task.project_id, leaseId)
      db.prepare("UPDATE tasks SET status='assigned',updated_at=? WHERE id=? AND workspace_id=? AND status='in_progress'").run(timestamp, task.id, task.workspace_id)
      return null
    }
    const runId = randomUUID()
    const correlationId = `hermes-coo:${task.id}:${runId}`
    db.prepare(`INSERT INTO hermes_coo_runs (run_id,tenant_id,workspace_id,project_id,task_id,agent_id,status,started_at,heartbeat_at,attempt,model_profile_id,provider_id,model_id,last_meaningful_activity,correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(runId, task.tenant_id, task.workspace_id, task.project_id, task.id, task.agent_id, 'RUNNING', timestamp, timestamp, Number(task.dispatch_attempts || 0) + 1, model.profile_id, model.provider_id, model.model_id, 'Run claimed by Mission Control scheduler', correlationId)
    return runId
  })()
}

async function executeClaim(task: any, leaseId: string | null = null, oneShot = false): Promise<{ ok: boolean; message: string; run_id?: string }> {
  const db = getDatabase()
  const model = tenantModel(task.tenant_id, task.agent_id, requiresResearch(task), db)
  if (!model) {
    if (leaseId) db.prepare("UPDATE hermes_coo_continuations SET lease_id=NULL,lease_until=NULL,continuation_state='READY',updated_at=? WHERE task_id=? AND tenant_id=? AND workspace_id=? AND project_id=? AND lease_id=?").run(now(), task.id, task.tenant_id, task.workspace_id, task.project_id, leaseId)
    markTask(db, task.id, task.workspace_id, 'blocked', 'Hermes background task blocked: no approved model profile')
    return { ok: false, message: `Task ${task.id} blocked: no approved Hermes model profile` }
  }

  const runId = createHermesRunIfEligible(task, model, leaseId, oneShot)
  if (!runId) return { ok: oneShot ? false : true, message: oneShot ? 'Hermes one-shot run was rejected by the final safety gate' : 'Hermes run start gate rejected stale eligibility' }
  const correlationId = `hermes-coo:${task.id}:${runId}`
  audit(runId, 'hermes.background_run_started', { task_id: task.id, project_id: task.project_id, provider: model.provider_id, model: model.model_id }, task.workspace_id, task.tenant_id)
  if (oneShot) logAuditEvent({ action: 'COO_CONTINUE_ONCE_STARTED', actor: 'Mission Control', target_type: 'hermes_coo_run', target_id: task.id, detail: { run_id: runId, task_id: task.id, project_id: task.project_id }, workspace_id: task.workspace_id, tenant_id: task.tenant_id })

  const user = backgroundUser(task.tenant_id, task.workspace_id)
  const sessionId = `mc_${task.tenant_id}_${task.workspace_id}_${task.agent_id}_${task.project_id}_bg_${runId.replaceAll('-', '')}`
  const binding = { tenantId: task.tenant_id, workspaceId: task.workspace_id, agentId: task.agent_id, projectId: task.project_id, sessionId }
  let actionCount = 0
  let researchSearches = 0
  let researchFetches = 0
  let approvalId: string | null = null
  let rejectedTaskResultStreak = 0
  let noProgressStreak = 0
  let beforeSources = 0
  let beforeEvidence = 0
  let beforeChecklist = ''
  const failedApproaches = new Map<string, string>()
  const heartbeat = (activity: string) => updateRun(runId, { heartbeat_at: now(), last_meaningful_activity: activity })

  try {
    const research = requiresResearch(task)
    const context = research ? buildHermesResearchProjectContext(user, task.project_id) : await buildHermesProjectContext(user, task.project_id)
    const metadata = parseMetadata(task.metadata)
    const scope = { tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id }
    if (research) ensureResearchChecklist(scope)
    beforeSources = Number((db.prepare("SELECT COUNT(*) c FROM hermes_research_sources WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND fetch_outcome='SUCCESS'").get(task.tenant_id, task.workspace_id, task.project_id, task.id) as any)?.c || 0)
    beforeEvidence = Number((db.prepare('SELECT COUNT(*) c FROM hermes_research_evidence WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=?').get(task.tenant_id, task.workspace_id, task.project_id, task.id) as any)?.c || 0)
    beforeChecklist = research ? JSON.stringify(getResearchChecklistState(scope)) : ''
    const baseSystemMessage = `Mission Control background COO execution. You are operating only on the server-authorized tenant ${task.tenant_id}, project ${task.project_id}, task ${task.id}. No shell, PTY, process spawn, credentials, filesystem mutation, financial action, deployment, or architecture change is available. ${research ? 'This is an evidence-first research task. Complete only the current server-selected objective. Do not silently skip it. Use exactly one bounded action in this turn and stop immediately after its closing </mc_action> tag. Do not emit a plan or prose. Preserve exact URLs, dates, and evidence classifications; do not invent access, legal, licensing, or commercial conclusions.' : ''} You may emit only these bounded actions: SAVE_WORKING_MEMORY, CREATE_TASK (must be assigned to yourself), UPDATE_TASK_RESULT (current task only), REQUEST_CEO_APPROVAL, SEARCH_WEB, FETCH_PUBLIC_URL, FETCH_PUBLIC_JSON_API, SAVE_RESEARCH_EVIDENCE. Do not create follow-up tasks unless strictly required by the task and never create more than one. Project context: ${JSON.stringify(context)}\nTask: ${JSON.stringify({ id: task.id, title: task.title, description: task.description, priority: task.priority })}`
    let researchTurnCount = 0
    let researchRepairCount = 0
    let researchInputTokens = 0
    let researchOutputTokens = 0
    let researchCacheRead = 0
    let researchCacheWrite = 0
    let researchMaxContextChars = 0
    let researchMaxContextTokens = 0
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      sendHermesBackgroundMessage({
        tenantId: task.tenant_id, workspaceId: task.workspace_id, agentId: task.agent_id, projectId: task.project_id,
        sessionId, message: `Execute the bounded task. Work only within the supplied context. Save useful working memory when appropriate, write a concise result, and use UPDATE_TASK_RESULT for the current task when finished.`,
        systemMessage: baseSystemMessage, provider: model.provider_id, model: model.model_id, onHeartbeat: heartbeat,
        researchRequired: research, maxIterations: HERMES_RESEARCH_LIMITS.maxIterations,
        researchTurnPrompt: research ? (turnNumber) => {
          const requirement = beginNextResearchRequirement(scope, runId)
          const compact = compactResearchContext(scope, runId)
          const contextJson = JSON.stringify(compact)
          const objective = requirement?.objective || 'Synthesize the evidence-backed final deliverable from the persisted checklist.'
          return {
            requirementId: requirement?.id || null,
            contextChars: contextJson.length,
            contextEstimatedTokens: Math.ceil(contextJson.length / 4),
            systemMessage: `${baseSystemMessage}\nCURRENT OBJECTIVE (server-selected, turn ${turnNumber}): ${objective}\nCompact research state: ${contextJson}`,
            message: `Advance only the current server-selected research objective: ${objective}. Use one bounded action now. The compact server state is: ${contextJson}`,
          }
        } : undefined,
        onResearchTurn: research ? (turn) => {
          const turnDb = getDatabase()
          const result = turnDb.prepare(`INSERT INTO hermes_coo_run_turns
            (run_id,tenant_id,workspace_id,project_id,task_id,turn_number,requirement_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,duration_ms,response_chars,action_type,action_accepted,repair_count,context_chars,context_estimated_tokens,started_at,completed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())`).run(runId, task.tenant_id, task.workspace_id, task.project_id, task.id, turn.turnNumber, turn.requirementId, turn.inputTokens, turn.outputTokens, turn.cacheReadTokens, turn.cacheWriteTokens, turn.durationMs, turn.responseChars, turn.actionType, turn.actionAccepted ? 1 : 0, turn.repairCount, turn.contextChars, turn.contextEstimatedTokens)
          if (turn.requirementId) turnDb.prepare(`UPDATE hermes_research_requirements SET action_refs=json_insert(COALESCE(action_refs,'[]'),'$[#]',?), updated_at=unixepoch() WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND requirement_id=?`).run(JSON.stringify({ run_id: runId, turn_id: Number(result.lastInsertRowid), action: turn.actionType, accepted: turn.actionAccepted }), task.tenant_id, task.workspace_id, task.project_id, task.id, turn.requirementId)
          researchTurnCount += 1
          researchRepairCount += turn.repairCount
          researchInputTokens += turn.inputTokens
          researchOutputTokens += turn.outputTokens
          researchCacheRead += turn.cacheReadTokens
          researchCacheWrite += turn.cacheWriteTokens
          researchMaxContextChars = Math.max(researchMaxContextChars, turn.contextChars)
          researchMaxContextTokens = Math.max(researchMaxContextTokens, turn.contextEstimatedTokens)
          updateRun(runId, { model_turn_count: researchTurnCount, repair_count: researchRepairCount, input_tokens: researchInputTokens, output_tokens: researchOutputTokens, cache_read_tokens: researchCacheRead, cache_write_tokens: researchCacheWrite, max_context_chars: researchMaxContextChars, max_context_estimated_tokens: researchMaxContextTokens })
        } : undefined,
        onAction: async (action) => {
          if (isPaused()) throw new Error('Mission Control is PAUSED')
          const researchScope = { tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id }
          if (research) {
            const compatibility = researchActionCompatibility(researchScope, action.action, runId)
            if (!compatibility.compatible) {
              actionCount += 1
              updateRun(runId, { action_count: actionCount, heartbeat_at: now(), last_meaningful_activity: `Rejected incompatible research action ${action.action}` })
              noProgressStreak += 1
              const contract = compatibility.contract
              const failed = [...failedApproaches.values()].slice(-4)
              if (noProgressStreak >= 4) throw new Error(`NO_PROGRESS_ON_CURRENT_REQUIREMENT: ${contract?.requirementId || 'unknown'}; repeated incompatible actions; required action types: ${contract?.requiredActionTypes.join(', ') || 'none'}`)
              return { code: 'ACTION_NOT_COMPATIBLE_WITH_CURRENT_REQUIREMENT', current_requirement: contract?.requirementId, rejected_action: action.action, required_action_types: contract?.requiredActionTypes || [], useful_action_types: contract?.usefulActionTypes || [], current_gap: contract?.currentGap, failed_approaches: failed, continue_research: true }
            }
          }
          actionCount += 1
          updateRun(runId, { action_count: actionCount, heartbeat_at: now(), last_meaningful_activity: `Bounded action ${action.action}` })
          if (actionCount > HERMES_BACKGROUND_LIMITS.maxActionsPerRun) throw new Error('Hermes action limit exceeded')
          const params = action.parameters || {}
          if (action.action === 'SAVE_WORKING_MEMORY') {
            return saveHermesMemory(user, binding, { title: String(params.title || '').slice(0, 240), content: String(params.content || '').slice(0, 20000), memory_type: (params.memory_type === 'current_state' || params.memory_type === 'product_context' || params.memory_type === 'operational_note') ? params.memory_type : 'operational_note' })
          }
          if (action.action === 'SEARCH_WEB') {
            rejectedTaskResultStreak = 0
            researchSearches += 1
            if (researchSearches > HERMES_RESEARCH_LIMITS.maxSearches) throw new Error('Hermes research search limit exceeded')
            updateRun(runId, { research_stage: 'SEARCH', heartbeat_at: now() })
            try { const result = await searchPublicWeb(String(params.query || ''), { tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id, runId }); noProgressStreak = 0; return result }
            catch (error) { const message = String(error instanceof Error ? error.message : error).slice(0, 300); failedApproaches.set(`SEARCH_WEB:${String(params.query || '').trim().toLowerCase()}`, `SEARCH_WEB ${String(params.query || '').slice(0, 160)} -> ${message}`); noProgressStreak += 1; if (noProgressStreak >= 4) throw new Error(`NO_PROGRESS_ON_CURRENT_REQUIREMENT: repeated failed searches; current requirement is ${researchExecutionContract(researchScope)?.requirementId || 'unknown'}`); return { error: message, query: String(params.query || ''), no_progress: noProgressStreak >= 3, failed_approaches: [...failedApproaches.values()].slice(-4) } }
          }
          if (action.action === 'FETCH_PUBLIC_URL' || action.action === 'FETCH_PUBLIC_JSON_API') {
            rejectedTaskResultStreak = 0
            researchFetches += 1
            if (researchFetches > HERMES_RESEARCH_LIMITS.maxFetches) throw new Error('Hermes research fetch limit exceeded')
            updateRun(runId, { research_stage: 'FETCH', heartbeat_at: now() })
            const scope = { tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id, runId }
            try { const result = action.action === 'FETCH_PUBLIC_JSON_API' ? await fetchPublicJsonApi(String(params.url || ''), scope) : await fetchPublicUrl(String(params.url || ''), scope); noProgressStreak = 0; return result }
            catch (error) { const message = String(error instanceof Error ? error.message : error).slice(0, 300); const url = String(params.url || ''); const sourceId = recordResearchFailure(scope, url, message); let key = `${action.action}:${url}`; try { const normalized = new URL(url); normalized.searchParams.delete('limit'); normalized.searchParams.delete('offset'); key = `${action.action}:${normalized.toString()}` } catch {} failedApproaches.set(key, `${action.action} ${url.slice(0, 180)} -> ${message}`); noProgressStreak += 1; if (noProgressStreak >= 4) throw new Error(`NO_PROGRESS_ON_CURRENT_REQUIREMENT: repeated failed fetches; current requirement is ${researchExecutionContract(researchScope)?.requirementId || 'unknown'}`); return { error: message, source_id: sourceId, url, no_progress: noProgressStreak >= 3, failed_approaches: [...failedApproaches.values()].slice(-4) } }
          }
          if (action.action === 'SAVE_RESEARCH_EVIDENCE') {
            rejectedTaskResultStreak = 0
            updateRun(runId, { research_stage: 'ASSESS', heartbeat_at: now() })
            return saveHermesEvidence({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id, runId }, {
              url: String(params.url || ''), title: String(params.title || ''), publisher: String(params.publisher || ''), claim: String(params.claim || ''), summary: String(params.summary || params.evidence_summary || ''), quote: typeof params.quote === 'string' ? params.quote : undefined, entity: typeof params.entity === 'string' ? params.entity : undefined, sourceId: Number.isInteger(Number(params.source_id)) ? Number(params.source_id) : undefined,
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
            const identity = normalizeHermesTaskResultIdentity(params, task.id)
            if (identity.mismatch) {
              audit(runId, 'hermes.background_task_identity_normalized', {
                action: action.action,
                supplied_task_id: identity.suppliedTaskId,
                canonical_task_id: identity.taskId,
              }, task.workspace_id, task.tenant_id)
            }
            const resultText = String(params.result || params.resolution || '').trim().slice(0, 10000)
            if (!resultText) throw new Error('Task result is required')
            const counts = researchCounts({ tenantId: task.tenant_id, workspaceId: task.workspace_id, taskId: task.id, runId })
            if (!meetsResearchCriteria(task, resultText, counts, runId)) {
              rejectedTaskResultStreak += 1
              const nextRequirement = getResearchChecklistState({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id }).find((row) => row.status === 'PENDING' || row.status === 'IN_PROGRESS')?.requirement_id || null
              if (rejectedTaskResultStreak >= 3) throw new Error(`Hermes research made no progress after repeated rejected UPDATE_TASK_RESULT; next requirement is ${nextRequirement || 'none'}`)
              return { task_id: task.id, status: 'in_progress', completion_rejected: true, reason: 'Required evidence-backed deliverables are incomplete', next_requirement: nextRequirement, continue_research: true, ...counts }
            }
            rejectedTaskResultStreak = 0
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
    const afterChecklist = research ? JSON.stringify(getResearchChecklistState({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id })) : ''
    const afterSources = Number((db.prepare("SELECT COUNT(*) c FROM hermes_research_sources WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND fetch_outcome='SUCCESS'").get(task.tenant_id, task.workspace_id, task.project_id, task.id) as any)?.c || 0)
    const outcome = classifyHermesRunOutcome({ runStatus: 'SUCCEEDED', taskStatus: current.status, beforeSources, afterSources, beforeEvidence, afterEvidence: beforeEvidence + counts.evidence_count, beforeChecklist, afterChecklist })
    finalizeHermesContinuation(task, runId, outcome, 'bounded_execution_completed', Number(response.inputTokens || 0), Number(response.outputTokens || 0), beforeChecklist, afterChecklist, oneShot)
    return { ok: true, message: `Hermes completed task ${task.id}`, run_id: runId }
  } catch (error: any) {
    if (error instanceof ApprovalRequested) {
      finalizeHermesContinuation(task, runId, 'WAITING_CEO', 'CEO approval required', 0, 0, beforeChecklist, beforeChecklist, oneShot)
      return { ok: true, message: `Task ${task.id} is waiting for CEO approval (${approvalId})`, run_id: runId }
    }
    const classification = error?.message === 'Mission Control is PAUSED' ? 'paused' : error?.message?.includes('timed out') ? 'timeout' : 'provider_or_runtime_error'
    const status = classification === 'paused' ? 'INTERRUPTED' : 'FAILED'
    const taskStatus = classification === 'paused' ? 'assigned' : 'blocked'
    markTask(db, task.id, task.workspace_id, taskStatus, `Hermes background execution ${status.toLowerCase()}: ${String(error?.message || error).slice(0, 500)}`)
    updateRun(runId, { status, completed_at: now(), heartbeat_at: now(), stop_reason: String(error?.message || error).slice(0, 500), error_classification: classification, last_meaningful_activity: `Hermes background execution ${status.toLowerCase()}` })
    audit(runId, 'hermes.background_run_failed', { task_id: task.id, classification, error: String(error?.message || error).slice(0, 500) }, task.workspace_id, task.tenant_id)
    const current = db.prepare('SELECT status FROM tasks WHERE id=? AND workspace_id=?').get(task.id, task.workspace_id) as any
    const afterSources = Number((db.prepare("SELECT COUNT(*) c FROM hermes_research_sources WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND fetch_outcome='SUCCESS'").get(task.tenant_id, task.workspace_id, task.project_id, task.id) as any)?.c || 0)
    const afterEvidence = Number((db.prepare('SELECT COUNT(*) c FROM hermes_research_evidence WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=?').get(task.tenant_id, task.workspace_id, task.project_id, task.id) as any)?.c || 0)
    const afterChecklist = requiresResearch(task) ? JSON.stringify(getResearchChecklistState({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id })) : ''
    const outcome = classifyHermesRunOutcome({ runStatus: status, taskStatus: current?.status || taskStatus, error: String(error?.message || error), beforeSources, afterSources, beforeEvidence, afterEvidence, beforeChecklist, afterChecklist })
    finalizeHermesContinuation(task, runId, outcome, String(error?.message || error), 0, 0, beforeChecklist, afterChecklist, oneShot)
    logger.warn({ runId, taskId: task.id, error }, 'Hermes background COO run failed')
    return { ok: false, message: `Hermes task ${task.id} ${status.toLowerCase()}: ${String(error?.message || error)}`, run_id: runId }
  }
}

export async function runHermesBackgroundTick(targetTaskId?: number, oneShot = false): Promise<{ ok: boolean; message: string; run_id?: string }> {
  const db = getDatabase()
  const timestamp = now()
  recoverStaleResearchClaims()
  const stale = db.prepare("SELECT run_id, task_id, workspace_id, tenant_id FROM hermes_coo_runs WHERE status = 'RUNNING' AND heartbeat_at < ?").all(timestamp - HERMES_BACKGROUND_LIMITS.staleAfterSeconds) as any[]
  for (const run of stale) {
    updateRun(run.run_id, { status: 'INTERRUPTED', completed_at: timestamp, stop_reason: 'stale heartbeat after Mission Control restart', error_classification: 'interrupted', last_meaningful_activity: 'Run interrupted during restart recovery' })
    db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ?, error_message = ? WHERE id = ? AND workspace_id = ? AND status = 'in_progress'").run(timestamp, 'Hermes run interrupted after stale heartbeat; manual retry required', run.task_id, run.workspace_id)
    audit(run.run_id, 'hermes.background_run_interrupted', { task_id: run.task_id }, run.workspace_id, run.tenant_id)
  }
  if (isPaused()) return { ok: !oneShot, message: oneShot ? 'Mission Control is PAUSED' : 'Hermes background dispatch paused' }
  const task = db.prepare(`SELECT t.*, a.id agent_id, a.name agent_name, a.runtime_type, w.tenant_id, c.enabled continuation_enabled
    FROM tasks t JOIN agents a ON lower(a.name) = lower(t.assigned_to) AND a.workspace_id = t.workspace_id
    JOIN workspaces w ON w.id = t.workspace_id
    JOIN tenants tenant ON tenant.id = w.tenant_id AND tenant.status = 'active'
    JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id AND p.status = 'active'
    LEFT JOIN hermes_coo_continuations c ON c.task_id=t.id AND c.tenant_id=w.tenant_id AND c.workspace_id=t.workspace_id AND c.project_id=t.project_id
    WHERE ${oneShot ? "t.status IN ('assigned','blocked')" : "t.status = 'assigned'"} AND lower(t.assigned_to) = 'hermes' AND lower(a.runtime_type) = 'hermes'
      AND json_extract(COALESCE(t.metadata, '{}'), '$.hermes_autonomous') = 1
      AND EXISTS (SELECT 1 FROM project_agent_assignments paa WHERE paa.project_id = t.project_id AND lower(paa.agent_name) = 'hermes')
      AND t.dispatch_attempts < ?
      AND ${oneShot ? "(c.enabled=1 AND c.continuation_state='NO_PROGRESS' AND (c.lease_until IS NULL OR c.lease_until < ?))" : "(c.task_id IS NULL OR (c.enabled=1 AND c.continuation_state IN ('READY','WAITING_RETRY') AND c.next_run_at IS NOT NULL AND c.next_run_at <= ? AND (c.lease_until IS NULL OR c.lease_until < ?)))"}
      ${targetTaskId ? 'AND t.id = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM hermes_coo_runs r WHERE r.tenant_id = w.tenant_id AND r.status IN ('QUEUED','RUNNING','WAITING_FOR_CEO'))
    ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC LIMIT 1`).get(...(oneShot ? [HERMES_BACKGROUND_LIMITS.maxAttempts, timestamp, ...(targetTaskId ? [targetTaskId] : [])] : [HERMES_BACKGROUND_LIMITS.maxAttempts, timestamp, timestamp, ...(targetTaskId ? [targetTaskId] : [])])) as any
  if (!task) return { ok: !oneShot, message: oneShot ? 'Task is not eligible for a bounded one-shot run' : 'No eligible Hermes background task' }
  if (oneShot && !tenantModel(task.tenant_id, task.agent_id, requiresResearch(task), db)) return { ok: false, message: 'Task has no approved Hermes model profile' }
  const previousStatus = task.status
  const claim = db.prepare(`UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status ${oneShot ? "IN ('assigned','blocked')" : "= 'assigned'"} AND workspace_id = ?`).run(timestamp, task.id, task.workspace_id)
  if (claim.changes !== 1) return { ok: false, message: 'Hermes task claim lost race' }
  let leaseId: string | null = null
  if (task.continuation_enabled || oneShot) {
    leaseId = randomUUID()
    const lease = db.prepare(`UPDATE hermes_coo_continuations SET continuation_state='RUNNING',lease_id=?,lease_until=?,automatic_runs=automatic_runs+1,sequence_no=sequence_no+1,updated_at=?
      WHERE task_id=? AND tenant_id=? AND workspace_id=? AND project_id=? AND enabled=1 AND ${oneShot ? "continuation_state='NO_PROGRESS'" : "continuation_state IN ('READY','WAITING_RETRY') AND next_run_at IS NOT NULL AND next_run_at <= ?"} AND (lease_until IS NULL OR lease_until < ?)`)
      .run(...(oneShot ? [leaseId, timestamp + HERMES_BACKGROUND_LIMITS.maxRunSeconds + 60, timestamp, task.id, task.tenant_id, task.workspace_id, task.project_id, timestamp] : [leaseId, timestamp + HERMES_BACKGROUND_LIMITS.maxRunSeconds + 60, timestamp, task.id, task.tenant_id, task.workspace_id, task.project_id, timestamp, timestamp]))
    if (lease.changes !== 1) {
      db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=? AND workspace_id=? AND status='in_progress'").run(previousStatus, timestamp, task.id, task.workspace_id)
      return { ok: false, message: 'Hermes continuation claim lost race' }
    }
    if (!oneShot) continuationAudit('COO_CONTINUATION_STARTED', ensureHermesContinuation({ tenantId: task.tenant_id, workspaceId: task.workspace_id, projectId: task.project_id, taskId: task.id }), { reason: 'scheduler lease acquired' })
  }
  eventBus.broadcast('task.status_changed', { id: task.id, status: 'in_progress', previous_status: previousStatus, workspace_id: task.workspace_id })
  return executeClaim(task, task.continuation_enabled || oneShot ? leaseId : null, oneShot)
}

export function getHermesBackgroundStatus(workspaceId?: number) {
  const db = getDatabase()
  recoverStaleResearchClaims()
  const task14 = db.prepare(`SELECT w.tenant_id,t.workspace_id,t.project_id,t.id AS task_id FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.title='Quebec Price Data Feasibility' ${workspaceId ? 'AND t.workspace_id=?' : ''} LIMIT 1`).get(...(workspaceId ? [workspaceId] : [])) as any
  if (task14?.tenant_id != null && task14?.project_id != null) recomputeResearchChecklist({ tenantId: task14.tenant_id, workspaceId: task14.workspace_id, projectId: task14.project_id, taskId: task14.task_id }, true)
  const where = workspaceId ? 'AND workspace_id = ?' : ''
  const params = workspaceId ? [workspaceId] : []
  const active = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM hermes_research_sources s WHERE s.run_id=r.run_id AND s.tenant_id=r.tenant_id) AS research_source_count, (SELECT COUNT(*) FROM hermes_research_evidence e WHERE e.run_id=r.run_id AND e.tenant_id=r.tenant_id) AS evidence_count FROM hermes_coo_runs r WHERE r.status IN ('QUEUED','RUNNING','WAITING_FOR_CEO') ${where.replaceAll('workspace_id', 'r.workspace_id')} ORDER BY r.started_at DESC LIMIT 1`).get(...params) as any
  const next = db.prepare(`SELECT id,title,project_id,status,assigned_to,created_at FROM tasks WHERE status = 'assigned' AND lower(assigned_to) = 'hermes' AND json_extract(COALESCE(metadata, '{}'), '$.hermes_autonomous') = 1 ${workspaceId ? 'AND workspace_id = ?' : ''} ORDER BY created_at LIMIT 1`).get(...params) as any
  const completedToday = db.prepare(`SELECT COUNT(*) c FROM hermes_coo_runs WHERE status = 'SUCCEEDED' AND completed_at >= unixepoch('start of day') ${workspaceId ? 'AND workspace_id = ?' : ''}`).get(...params) as any
  const blocked = db.prepare(`SELECT id,title,status,project_id,updated_at,error_message FROM tasks WHERE status IN ('blocked','awaiting_owner') ${workspaceId ? 'AND workspace_id = ?' : ''} AND (lower(assigned_to) = 'hermes' OR json_extract(COALESCE(metadata, '{}'), '$.hermes_autonomous') = 1) ORDER BY updated_at DESC LIMIT 20`).all(...params)
  const approvals = db.prepare(`SELECT * FROM hermes_coo_approvals WHERE status = 'PENDING' ${workspaceId ? 'AND workspace_id = ?' : ''} ORDER BY requested_at DESC LIMIT 20`).all(...params)
  const continuations = db.prepare(`SELECT * FROM hermes_coo_continuations ${workspaceId ? 'WHERE workspace_id = ?' : ''} ORDER BY updated_at DESC LIMIT 50`).all(...params)
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
  return { paused, state: resolveHermesBackgroundState({ paused, activeStatus: active?.status || null, hasCurrentFailure: Boolean(currentFailure), hasCurrentBlock: blocked.length > 0 }), current: active || null, next, completed_today: completedToday?.c || 0, blocked, approvals, continuations, recent_failure: recentFailure || null, recent_outputs: recentOutputs }
}

export function setHermesContinuation(taskId: number, workspaceId: number, enabled: boolean) {
  const db = getDatabase()
  const task = db.prepare(`SELECT t.*,w.tenant_id FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=? AND t.workspace_id=?`).get(taskId, workspaceId) as any
  if (!task) throw new Error('Task not found')
  if (!autonomousPermitted(task)) throw new Error('Task does not explicitly permit autonomous COO execution')
  const row = ensureHermesContinuation({ tenantId: task.tenant_id, workspaceId, projectId: task.project_id, taskId })
  const timestamp = now()
  if (enabled) {
    if (['done', 'review', 'awaiting_owner'].includes(task.status)) throw new Error('Task is already at a terminal or review boundary')
    db.prepare(`UPDATE hermes_coo_continuations SET enabled=1,continuation_state='READY',last_outcome=NULL,stop_reason=NULL,next_run_at=?,sequence_started_at=?,automatic_runs=0,consecutive_no_progress=0,cumulative_input_tokens=0,cumulative_output_tokens=0,updated_at=? WHERE task_id=? AND workspace_id=?`).run(timestamp, timestamp, timestamp, taskId, workspaceId)
    db.prepare("UPDATE tasks SET status='assigned',updated_at=? WHERE id=? AND workspace_id=? AND status IN ('blocked','awaiting_owner')").run(timestamp, taskId, workspaceId)
    const next = ensureHermesContinuation({ tenantId: task.tenant_id, workspaceId, projectId: task.project_id, taskId })
    continuationAudit('COO_AUTO_CONTINUATION_ENABLED', next, { reason: 'authorized control-plane enable' })
    return next
  }
  db.prepare(`UPDATE hermes_coo_continuations SET enabled=0,continuation_state='READY',next_run_at=NULL,lease_id=NULL,lease_until=NULL,stop_reason='Disabled by authorized control-plane action',updated_at=? WHERE task_id=? AND workspace_id=?`).run(timestamp, taskId, workspaceId)
  const next = ensureHermesContinuation({ tenantId: task.tenant_id, workspaceId, projectId: task.project_id, taskId })
  continuationAudit('COO_AUTO_CONTINUATION_DISABLED', next, { reason: 'authorized control-plane disable' })
  return next
}

export async function continueHermesTaskOnce(taskId: number, workspaceId: number) {
  const db = getDatabase()
  const task = db.prepare(`SELECT t.*,w.tenant_id FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=? AND t.workspace_id=?`).get(taskId, workspaceId) as any
  if (!task || !autonomousPermitted(task)) throw new Error('Task is not eligible for bounded COO execution')
  if (['done', 'review', 'awaiting_owner'].includes(task.status)) throw new Error('Task is already at a terminal or review boundary')
  logAuditEvent({ action: 'COO_CONTINUE_ONCE_REQUESTED', actor: 'Mission Control', target_type: 'task', target_id: taskId, detail: { tenant_id: task.tenant_id, workspace_id: workspaceId, project_id: task.project_id }, workspace_id: workspaceId, tenant_id: task.tenant_id })
  const result = await runHermesBackgroundTick(taskId, true)
  if (!result.ok) logAuditEvent({ action: 'COO_CONTINUE_ONCE_REJECTED', actor: 'Mission Control', target_type: 'task', target_id: taskId, detail: { tenant_id: task.tenant_id, workspace_id: workspaceId, project_id: task.project_id, reason: result.message }, workspace_id: workspaceId, tenant_id: task.tenant_id })
  return result
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
