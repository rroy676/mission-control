import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { db_helpers, getDatabase, logAuditEvent } from '@/lib/db'
import { bindingForSession, createHermesTask, hermesCreateTaskSchema, saveHermesMemory } from '@/lib/hermes-coo'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

const requestSchema = z.object({ action: z.enum(['CREATE_TASK', 'SAVE_WORKING_MEMORY', 'REQUEST_CEO_APPROVAL']), session_id: z.string().min(1).max(200), idempotency_key: z.string().trim().min(1).max(200).optional(), parameters: z.record(z.string(), z.unknown()).default({}) }).strict()

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  let rejectedBody: { action?: string; session_id?: string } = {}
  try {
    const body = requestSchema.parse(await request.json())
    rejectedBody = body
    const correlationId = request.headers.get('x-request-id') || randomUUID()
    const binding = bindingForSession(auth.user, body.session_id)
    let result: unknown
    if (body.action === 'CREATE_TASK') result = createHermesTask(auth.user, binding, hermesCreateTaskSchema.parse(body.parameters), body.idempotency_key)
    else if (body.action === 'SAVE_WORKING_MEMORY') result = saveHermesMemory(auth.user, binding, z.object({ title: z.string().min(1).max(240), content: z.string().min(1).max(20_000), memory_type: z.enum(['current_state', 'product_context', 'operational_note']) }).parse(body.parameters))
    else result = { status: 'approval_required', message: 'CEO approval is required; no approval was granted.' }
    return NextResponse.json({ ok: true, action: body.action, action_id: randomUUID(), correlation_id: correlationId, result })
  } catch (error) {
    const reason = error instanceof z.ZodError ? 'Invalid structured action parameters' : error instanceof Error ? error.message : 'Action failed'
    try {
      const db = getDatabase()
      const actor = 'Hermes'
      db_helpers.logActivity('hermes_action_rejected', 'agent', 0, actor, `Hermes action rejected: ${rejectedBody.action || 'unknown'}`, { action: rejectedBody.action || null, session_id: rejectedBody.session_id || null, reason }, auth.user.workspace_id)
      logAuditEvent({ action: 'hermes.action_rejected', actor, target_type: 'structured_action', detail: { action: rejectedBody.action || null, session_id: rejectedBody.session_id || null, reason, classification: reason.toLowerCase().includes('approval') ? 'approval_required' : 'unauthorized_or_invalid' }, workspace_id: auth.user.workspace_id, tenant_id: auth.user.tenant_id })
    } catch {}
    return NextResponse.json({ error: reason, classification: reason.toLowerCase().includes('approval') ? 'approval_required' : 'unauthorized_or_invalid' }, { status: 403 })
  }
}
