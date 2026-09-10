import { getDatabase, logAuditEvent } from '@/lib/db'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { logger } from '@/lib/logger'
import { buildHermesProjectContext } from '@/lib/hermes-coo'
import { requireProfileContext, resolveEffectiveModel } from '@/lib/model-profiles'
import type { User } from '@/lib/auth'

const REQUEST_TIMEOUT_MS = 15_000
export type HermesErrorCode = 'not_configured' | 'unavailable' | 'authentication' | 'session' | 'invalid_response' | 'provider_error' | 'timeout'
export class HermesRuntimeError extends Error {
  constructor(public readonly code: HermesErrorCode, message: string, public readonly status = 503) { super(message); this.name = 'HermesRuntimeError' }
}
function baseUrl() { return (process.env.MC_HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/$/, '') }
function apiKey() { return process.env.MC_HERMES_API_KEY || process.env.API_SERVER_KEY || '' }
function missionControlBaseUrl() { return (process.env.MC_INTERNAL_BASE_URL || `http://${process.env.HOSTNAME || '172.20.0.1'}:${process.env.PORT || '3000'}`).replace(/\/$/, '') }
function missionControlApiKey() { return (process.env.API_KEY || '').trim() }
async function request(path: string, init: RequestInit = {}, allowedStatuses: number[] = []) {
  const key = apiKey()
  if (!key || key.length < 16) throw new HermesRuntimeError('not_configured', 'Hermes API is not configured')
  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError'
    logger.warn({ error_class: timeout ? 'timeout' : 'connection_failure' }, 'Hermes runtime API request failed')
    throw new HermesRuntimeError(timeout ? 'timeout' : 'unavailable', timeout ? 'Hermes runtime timed out' : 'Hermes runtime unavailable')
  }
  let body: any = null
  try { body = await response.json() } catch {}
  if (response.status === 401 || response.status === 403) throw new HermesRuntimeError('authentication', 'Hermes authentication failed', 502)
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    const providerError = typeof body?.error?.code === 'string' || typeof body?.error?.message === 'string'
    throw new HermesRuntimeError(response.status === 404 ? 'session' : providerError ? 'provider_error' : 'unavailable', response.status === 404 ? 'Hermes session unavailable' : providerError ? 'Hermes provider rejected the request' : 'Hermes runtime request failed', providerError ? 502 : 503)
  }
  return { response, body }
}
async function dispatchStructuredAction(action: { action: string; parameters: Record<string, unknown> }, sessionId: string) {
  const key = missionControlApiKey()
  if (key.length < 16) throw new HermesRuntimeError('not_configured', 'Mission Control API is not configured')
  const correlationId = randomUUID()
  const idempotencyKey = `hermes:${sessionId}:${action.action}:${createHash('sha256').update(JSON.stringify(action.parameters)).digest('hex').slice(0, 32)}`
  let response: { statusCode?: number; body: any }
  const target = new URL(`${missionControlBaseUrl()}/api/hermes/actions`)
  const payload = JSON.stringify({ action: action.action, session_id: sessionId, idempotency_key: idempotencyKey, parameters: action.parameters })
  try {
    response = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'x-api-key': key, 'x-request-id': correlationId, Host: `localhost:${process.env.PORT || '3000'}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => { let parsed: any = null; try { parsed = JSON.parse(body) } catch {}; resolve({ statusCode: res.statusCode, body: parsed }) })
      })
      req.on('timeout', () => req.destroy(new Error('request timeout')))
      req.on('error', reject)
      req.end(payload)
    })
  } catch { throw new HermesRuntimeError('unavailable', 'Mission Control structured action route unavailable') }
  if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) throw new HermesRuntimeError('unavailable', 'Mission Control structured action was rejected', (response.statusCode || 500) >= 500 ? 503 : 403)
  return { ...response.body, correlation_id: response.body?.correlation_id || correlationId, idempotency_key: idempotencyKey }
}
export async function checkHermesHealth() {
  if (!apiKey() || apiKey().length < 16) return { available: false, status: 'NOT_CONFIGURED' }
  try { const { body } = await request('/health'); return { available: body?.status === 'ok', status: body?.status === 'ok' ? 'AVAILABLE' : 'DEGRADED', version: typeof body?.version === 'string' ? body.version : undefined } }
  catch (error) { return { available: false, status: error instanceof HermesRuntimeError && error.code === 'authentication' ? 'DEGRADED' : 'OFFLINE' } }
}
export function hermesSessionIdFor(tenantId: number, workspaceId: number, agentId: number, projectId: number | null) { return `mc_${tenantId}_${workspaceId}_${agentId}_${projectId || 'default'}` }

type HermesSessionInput = {
  tenantId: number
  workspaceId: number
  agentId: number
  projectId?: number | null
  actorUser?: User
}

/**
 * Create or reuse the server-owned Hermes session for one tenant/project
 * scope. The caller must resolve project authorization before passing a
 * project id here; the binding itself is still written with server-side
 * tenant/workspace ids.
 */
export async function ensureHermesSession(input: HermesSessionInput) {
  const db = getDatabase()
  const projectId = input.projectId ?? null
  const effectiveModel = input.actorUser
    ? resolveEffectiveModel(requireProfileContext(input.actorUser), { agentId: input.agentId, purpose: 'general' })
    : null
  const existing = db.prepare('SELECT hermes_session_id FROM hermes_runtime_bindings WHERE tenant_id = ? AND workspace_id = ? AND agent_id = ? AND project_id IS ?').get(input.tenantId, input.workspaceId, input.agentId, projectId) as { hermes_session_id: string } | undefined
  const sessionId = existing?.hermes_session_id || hermesSessionIdFor(input.tenantId, input.workspaceId, input.agentId, projectId)

  if (!existing) {
    const created = await request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: sessionId,
        source: 'mission_control',
        title: `Mission Control · ${input.actorUser?.display_name || input.actorUser?.username || 'CEO'}`,
        ...(effectiveModel ? { provider: effectiveModel.provider_id, model: effectiveModel.model_id } : {}),
      }),
    }, [409])
    if (created.response.status !== 201 && created.response.status !== 409) throw new HermesRuntimeError('session', 'Hermes session unavailable')
    db.prepare('INSERT OR IGNORE INTO hermes_runtime_bindings (tenant_id, workspace_id, agent_id, project_id, hermes_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())').run(input.tenantId, input.workspaceId, input.agentId, projectId, sessionId)
  }

  if (effectiveModel) {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      body: JSON.stringify({ provider: effectiveModel.provider_id, model: effectiveModel.model_id }),
    })
  }

  return { sessionId, projectId }
}
export function normalizeHermesResponse(body: any): { content: string | null; reasoning: string | null; finishReason: string | null; toolCallState: 'none' | 'structured' | 'reasoning_only' | 'empty' } {
  const message = body?.message && typeof body.message === 'object' ? body.message : body?.choices?.[0]?.message && typeof body.choices[0].message === 'object' ? body.choices[0].message : body
  let content = typeof message?.content === 'string' ? message.content.trim() : null
  const reasoning = typeof message?.reasoning === 'string' ? message.reasoning.trim() : typeof message?.reasoning_content === 'string' ? message.reasoning_content.trim() : null
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (!content && toolCalls.length > 0) {
    const tool = toolCalls[0]
    const name = typeof tool?.function?.name === 'string' ? tool.function.name : typeof tool?.name === 'string' ? tool.name : ''
    const args = typeof tool?.function?.arguments === 'string' ? tool.function.arguments : tool?.function?.arguments && typeof tool.function.arguments === 'object' ? JSON.stringify(tool.function.arguments) : tool?.arguments && typeof tool.arguments === 'object' ? JSON.stringify(tool.arguments) : ''
    if (name && args) {
      try { content = `<tool_call>${JSON.stringify({ name, arguments: JSON.parse(args) })}</tool_call>` } catch { /* malformed tool arguments remain an invalid model response */ }
    }
  }
  const finishReason = typeof message?.finish_reason === 'string' ? message.finish_reason : typeof body?.choices?.[0]?.finish_reason === 'string' ? body.choices[0].finish_reason : typeof body?.finish_reason === 'string' ? body.finish_reason : null
  return { content: content || null, reasoning: reasoning || null, finishReason, toolCallState: content ? (toolCalls.length > 0 || /<tool_call>|<｜DSML｜tool_call>/i.test(content) ? 'structured' : 'none') : reasoning ? 'reasoning_only' : 'empty' }
}

export function extractHermesAction(content: string): { action: string; parameters: Record<string, unknown> } | null {
  const match = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i)
  if (match) try {
    const parsed = JSON.parse(match[1]) as { name?: string; arguments?: Record<string, unknown> }
    if (!parsed.name || !['CREATE_TASK', 'SAVE_WORKING_MEMORY', 'REQUEST_CEO_APPROVAL'].includes(parsed.name)) return null
    return { action: parsed.name, parameters: parsed.arguments || {} }
  } catch { return null }
  const dsml = content.match(/<｜DSML｜tool_call>([\s\S]*?)<\/?｜DSML｜tool_call>/i)
  if (!dsml) return null
  const parameters: Record<string, unknown> = {}
  for (const item of dsml[1].matchAll(/<｜DSML｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜DSML｜parameter>/gi)) parameters[item[1]] = item[2].trim()
  const action = typeof parameters.action === 'string' ? parameters.action : typeof parameters.name === 'string' ? parameters.name : ''
  if (typeof parameters.arguments === 'string') {
    try { Object.assign(parameters, JSON.parse(parameters.arguments)) } catch { return null }
  }
  delete parameters.action
  delete parameters.name
  delete parameters.arguments
  if (action === 'CREATE_TASK') {
    if (typeof parameters.objective !== 'string' && typeof parameters.description === 'string') parameters.objective = parameters.description
    delete parameters.description
    delete parameters.status
    delete parameters.task_type
    delete parameters.project_id
  }
  return ['CREATE_TASK', 'SAVE_WORKING_MEMORY', 'REQUEST_CEO_APPROVAL'].includes(action) ? { action, parameters } : null
}

export async function sendHermesMessage(input: { tenantId: number; workspaceId: number; agentId: number; projectId?: number | null; message: string; systemMessage?: string; actor: string; actorUser?: User }) {
  const db = getDatabase(), projectId = input.projectId ?? null
  const { sessionId } = await ensureHermesSession(input)
  const effectiveModel = input.actorUser ? resolveEffectiveModel(requireProfileContext(input.actorUser), { agentId: input.agentId, purpose: 'general' }) : null
  let system = input.systemMessage || ''
  if (input.projectId && input.actorUser) {
    const context = await buildHermesProjectContext(input.actorUser, input.projectId)
    system += `\n\nMission Control COO boundary: You are bound to tenant ${input.tenantId}, project ${context.project.name} (id ${context.project.id}), agent ${input.agentId}, actor ${input.actor}. You have no filesystem, shell, PTY, spawn, or arbitrary HTTP authority. Use only the structured actions below, emitting exactly one JSON object inside <tool_call> tags when an action is required. Allowed names: CREATE_TASK, SAVE_WORKING_MEMORY, REQUEST_CEO_APPROVAL. Project context (server-resolved):\n${JSON.stringify(context)}\nIf the requested knowledge file is absent, say so; never invent it. CEO approval is required for licensing, pricing, spending, legal/privacy acceptance, architecture changes, or transfers.`
  }
  const body: Record<string, unknown> = { message: input.message }; if (system) body.system_message = system
  if (effectiveModel) { body.provider = effectiveModel.provider_id; body.model = effectiveModel.model_id; body.require_model_lock = true }
  const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, { method: 'POST', body: JSON.stringify(body) })
  let normalized = normalizeHermesResponse(result.body)
  let response = normalized.content
  if (!response) throw new HermesRuntimeError('invalid_response', normalized.toolCallState === 'reasoning_only' ? 'Hermes returned reasoning without a final response' : 'Hermes returned an empty response', 502)
  const effectiveSessionId = typeof result.body?.session_id === 'string' ? result.body.session_id : sessionId
  db.prepare('UPDATE hermes_runtime_bindings SET hermes_session_id = ?, updated_at = unixepoch() WHERE tenant_id = ? AND workspace_id = ? AND agent_id = ? AND project_id IS ?').run(effectiveSessionId, input.tenantId, input.workspaceId, input.agentId, projectId)
  const actorUser = input.actorUser
  const action = actorUser && input.projectId ? extractHermesAction(response) : null
  let actionResult: unknown = null
  if (action && actorUser && input.projectId) {
    actionResult = await dispatchStructuredAction(action, effectiveSessionId)
    const followup = await request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, { method: 'POST', body: JSON.stringify({ message: `<tool_response>${JSON.stringify({ action: action.action, result: actionResult })}</tool_response>`, system_message: 'Continue with a concise final answer. Do not emit another tool call.' }) })
    normalized = normalizeHermesResponse(followup.body)
    if (!normalized.content) throw new HermesRuntimeError('invalid_response', normalized.toolCallState === 'reasoning_only' ? 'Hermes returned reasoning without a final response after the action' : 'Hermes returned an empty follow-up response after the action', 502)
    response = normalized.content
  }
  return { sessionId: effectiveSessionId, response, action: action?.action || null, actionResult }
}
export function recordHermesInteraction(input: { workspaceId: number; tenantId: number; agentId: number; actor: string; message: string; response: string; sessionId: string; projectId?: number | null }) {
  const db = getDatabase(), detail = { runtime: 'hermes', tenant_id: input.tenantId, project_id: input.projectId ?? null, session_id: input.sessionId, message_length: input.message.length, response_length: input.response.length }
  db.prepare('INSERT INTO hermes_interactions (tenant_id, workspace_id, agent_id, project_id, session_id, actor, message, response, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'success\', unixepoch())').run(input.tenantId, input.workspaceId, input.agentId, input.projectId ?? null, input.sessionId, input.actor, input.message, input.response)
  logAuditEvent({ action: 'hermes_message_sent', actor: input.actor, target_type: 'agent', target_id: input.agentId, detail, workspace_id: input.workspaceId, tenant_id: input.tenantId })
}
