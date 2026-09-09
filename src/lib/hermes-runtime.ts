import { getDatabase, logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'

const REQUEST_TIMEOUT_MS = 15_000
export type HermesErrorCode = 'not_configured' | 'unavailable' | 'authentication' | 'session' | 'invalid_response'
export class HermesRuntimeError extends Error {
  constructor(public readonly code: HermesErrorCode, message: string, public readonly status = 503) { super(message); this.name = 'HermesRuntimeError' }
}
function baseUrl() { return (process.env.MC_HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/$/, '') }
function apiKey() { return process.env.MC_HERMES_API_KEY || process.env.API_SERVER_KEY || '' }
async function request(path: string, init: RequestInit = {}, allowedStatuses: number[] = []) {
  const key = apiKey()
  if (!key || key.length < 16) throw new HermesRuntimeError('not_configured', 'Hermes API is not configured')
  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) { logger.warn({ err: error }, 'Hermes runtime API unavailable'); throw new HermesRuntimeError('unavailable', 'Hermes runtime unavailable') }
  let body: any = null
  try { body = await response.json() } catch {}
  if (response.status === 401 || response.status === 403) throw new HermesRuntimeError('authentication', 'Hermes authentication failed', 502)
  if (!response.ok && !allowedStatuses.includes(response.status)) throw new HermesRuntimeError(response.status === 404 ? 'session' : 'unavailable', response.status === 404 ? 'Hermes session unavailable' : 'Hermes runtime request failed')
  return { response, body }
}
export async function checkHermesHealth() {
  if (!apiKey() || apiKey().length < 16) return { available: false, status: 'NOT_CONFIGURED' }
  try { const { body } = await request('/health'); return { available: body?.status === 'ok', status: body?.status === 'ok' ? 'AVAILABLE' : 'DEGRADED', version: typeof body?.version === 'string' ? body.version : undefined } }
  catch (error) { return { available: false, status: error instanceof HermesRuntimeError && error.code === 'authentication' ? 'DEGRADED' : 'OFFLINE' } }
}
function sessionIdFor(tenantId: number, workspaceId: number, agentId: number, projectId: number | null) { return `mc_${tenantId}_${workspaceId}_${agentId}_${projectId || 'default'}` }
export async function sendHermesMessage(input: { tenantId: number; workspaceId: number; agentId: number; projectId?: number | null; message: string; systemMessage?: string; actor: string }) {
  const db = getDatabase(), projectId = input.projectId ?? null
  const existing = db.prepare('SELECT hermes_session_id FROM hermes_runtime_bindings WHERE tenant_id = ? AND workspace_id = ? AND agent_id = ? AND project_id IS ?').get(input.tenantId, input.workspaceId, input.agentId, projectId) as { hermes_session_id: string } | undefined
  const sessionId = existing?.hermes_session_id || sessionIdFor(input.tenantId, input.workspaceId, input.agentId, projectId)
  if (!existing) {
    const created = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ id: sessionId, source: 'mission_control', title: `Mission Control · ${input.actor}` }) }, [409])
    if (created.response.status !== 201 && created.response.status !== 409) throw new HermesRuntimeError('session', 'Hermes session unavailable')
    db.prepare('INSERT OR IGNORE INTO hermes_runtime_bindings (tenant_id, workspace_id, agent_id, project_id, hermes_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())').run(input.tenantId, input.workspaceId, input.agentId, projectId, sessionId)
  }
  const body: Record<string, unknown> = { message: input.message }; if (input.systemMessage) body.system_message = input.systemMessage
  const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, { method: 'POST', body: JSON.stringify(body) })
  const response = result.body?.message?.content
  if (typeof response !== 'string') throw new HermesRuntimeError('invalid_response', 'Hermes returned an invalid response', 502)
  const effectiveSessionId = typeof result.body?.session_id === 'string' ? result.body.session_id : sessionId
  db.prepare('UPDATE hermes_runtime_bindings SET hermes_session_id = ?, updated_at = unixepoch() WHERE tenant_id = ? AND workspace_id = ? AND agent_id = ? AND project_id IS ?').run(effectiveSessionId, input.tenantId, input.workspaceId, input.agentId, projectId)
  return { sessionId: effectiveSessionId, response }
}
export function recordHermesInteraction(input: { workspaceId: number; tenantId: number; agentId: number; actor: string; message: string; response: string; sessionId: string; projectId?: number | null }) {
  const db = getDatabase(), detail = { runtime: 'hermes', tenant_id: input.tenantId, project_id: input.projectId ?? null, session_id: input.sessionId, message_length: input.message.length, response_length: input.response.length }
  db.prepare('INSERT INTO hermes_interactions (tenant_id, workspace_id, agent_id, project_id, session_id, actor, message, response, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'success\', unixepoch())').run(input.tenantId, input.workspaceId, input.agentId, input.projectId ?? null, input.sessionId, input.actor, input.message, input.response)
  logAuditEvent({ action: 'hermes_message_sent', actor: input.actor, target_type: 'agent', target_id: input.agentId, detail, workspace_id: input.workspaceId, tenant_id: input.tenantId })
}
