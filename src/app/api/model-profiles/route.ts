import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { canMutateProfiles, createCredentialReference, listProfiles, requireProfileContext, resolveEffectiveModel, saveProfile } from '@/lib/model-profiles'
import { z } from 'zod'
import { recordTenantAuthorizationDecision } from '@/lib/tenant-context'

const profileInput = z.object({
  provider_id: z.string().min(1).max(120), model_id: z.string().min(1).max(200), purpose: z.enum(['general', 'engineering', 'chat', 'workflow', 'task']).optional(),
  scope: z.enum(['tenant-default', 'agent-override', 'workflow-override', 'task-override']).optional(), agent_id: z.number().int().positive().nullable().optional(),
  workflow_id: z.number().int().positive().nullable().optional(), task_id: z.number().int().positive().nullable().optional(), enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100000).optional(), credential_ref: z.string().max(120).nullable().optional(), fallback_profile_id: z.number().int().positive().nullable().optional(),
  promotional_free: z.boolean().optional(), promotional_expires_at: z.number().int().nullable().optional(), effective_from: z.number().int().optional(), expires_at: z.number().int().nullable().optional(),
}).strict()

function context(request: NextRequest, user: NonNullable<ReturnType<typeof getUserFromRequest>>) {
  const key = request.nextUrl.searchParams.get('tenant_key')
  return requireProfileContext(user, key)
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const tenant = context(request, user)
    const effective = resolveEffectiveModel(tenant, {
      agentId: Number(request.nextUrl.searchParams.get('agent_id')) || undefined,
      workflowId: Number(request.nextUrl.searchParams.get('workflow_id')) || undefined,
      taskId: Number(request.nextUrl.searchParams.get('task_id')) || undefined,
      purpose: (request.nextUrl.searchParams.get('purpose') as any) || 'general',
    })
    return NextResponse.json({ profiles: listProfiles(tenant), effective })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Tenant context unavailable' }, { status: 403 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const tenant = context(request, user)
    if (!canMutateProfiles(tenant)) return NextResponse.json({ error: 'Tenant owner or admin role required' }, { status: 403 })
    const body = profileInput.parse(await request.json())
    const profile = saveProfile(tenant, body, getDatabase())
    logAuditEvent({ action: 'tenant_model_profile_created', actor: user.username, actor_id: user.id, target_type: 'tenant_model_profile', target_id: profile.id, detail: { tenant_id: tenant.id, scope: profile.scope, purpose: profile.purpose, provider_id: profile.provider_id, model_id: profile.model_id, credential_ref: profile.credential_ref } })
    return NextResponse.json({ profile }, { status: 201 })
  } catch (error) {
    if (user && error instanceof Error && /tenant|credential|Agent|Workflow|Task|Fallback/.test(error.message)) {
      recordTenantAuthorizationDecision(getDatabase(), user, request.nextUrl.searchParams.get('tenant_key'), null, 'model_profile_mutation', 'deny', 'profile_reference_not_authorized')
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid model profile' }, { status: error instanceof z.ZodError ? 400 : 400 })
  }
}
