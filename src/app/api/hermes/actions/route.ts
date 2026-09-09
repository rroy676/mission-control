import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { bindingForSession, createHermesTask, hermesCreateTaskSchema, saveHermesMemory } from '@/lib/hermes-coo'
import { z } from 'zod'

const requestSchema = z.object({ action: z.enum(['CREATE_TASK', 'SAVE_WORKING_MEMORY', 'REQUEST_CEO_APPROVAL']), session_id: z.string().min(1).max(200), parameters: z.record(z.string(), z.unknown()).default({}) }).strict()

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const body = requestSchema.parse(await request.json())
    const binding = bindingForSession(auth.user, body.session_id)
    let result: unknown
    if (body.action === 'CREATE_TASK') result = createHermesTask(auth.user, binding, hermesCreateTaskSchema.parse(body.parameters))
    else if (body.action === 'SAVE_WORKING_MEMORY') result = saveHermesMemory(auth.user, binding, z.object({ title: z.string().min(1).max(240), content: z.string().min(1).max(20_000), memory_type: z.enum(['current_state', 'product_context', 'operational_note']) }).parse(body.parameters))
    else result = { status: 'approval_required', message: 'CEO approval is required; no approval was granted.' }
    return NextResponse.json({ ok: true, action: body.action, result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof z.ZodError ? 'Invalid structured action' : error instanceof Error ? error.message : 'Action failed' }, { status: 403 })
  }
}
