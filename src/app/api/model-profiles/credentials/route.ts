import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { createCredentialReference, canMutateProfiles, requireProfileContext } from '@/lib/model-profiles'
import { recordTenantAuthorizationDecision } from '@/lib/tenant-context'
import { getDatabase } from '@/lib/db'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const body = await request.json()
    const tenant = requireProfileContext(user, typeof body?.tenant_key === 'string' ? body.tenant_key : null)
    if (!canMutateProfiles(tenant)) return NextResponse.json({ error: 'Tenant owner or admin role required' }, { status: 403 })
    createCredentialReference(tenant, String(body.provider_id || ''), String(body.credential_ref || ''))
    return NextResponse.json({ credential_ref: body.credential_ref, provider_id: body.provider_id, status: 'unconfigured' }, { status: 201 })
  } catch (error) {
    recordTenantAuthorizationDecision(getDatabase(), user, null, null, 'credential_reference_mutation', 'deny', 'credential_reference_not_authorized')
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid credential reference' }, { status: 400 })
  }
}
