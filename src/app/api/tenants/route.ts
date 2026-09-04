import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { listAuthorizedTenants, selectTenantForSession } from '@/lib/tenant-context'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const tenants = listAuthorizedTenants(user)
  return NextResponse.json({ tenants, active_tenant: tenants.find((tenant) => tenant.active) || null })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user || !user.sessionId) return NextResponse.json({ error: 'Tenant selection requires a session' }, { status: 403 })
  try {
    const body = await request.json()
    const tenantKey = typeof body?.tenant_key === 'string' ? body.tenant_key : ''
    if (!/^tnt_[a-f0-9]{32}$/.test(tenantKey)) return NextResponse.json({ error: 'Invalid tenant key' }, { status: 400 })
    const selected = selectTenantForSession(user, tenantKey)
    if (!selected) return NextResponse.json({ error: 'Tenant is not authorized for this user' }, { status: 403 })
    return NextResponse.json({ active_tenant: selected })
  } catch {
    return NextResponse.json({ error: 'Invalid tenant selection' }, { status: 400 })
  }
}
