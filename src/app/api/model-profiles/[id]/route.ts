import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { canMutateProfiles, requireProfileContext } from '@/lib/model-profiles'
import { z } from 'zod'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const tenant = requireProfileContext(user, request.nextUrl.searchParams.get('tenant_key'))
    if (!canMutateProfiles(tenant)) return NextResponse.json({ error: 'Tenant owner or admin role required' }, { status: 403 })
    const id = Number((await params).id)
    if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid profile id' }, { status: 400 })
    const body = z.object({ enabled: z.boolean() }).strict().parse(await request.json())
    const db = getDatabase()
    const result = db.prepare('UPDATE tenant_model_profiles SET enabled = ?, updated_at = unixepoch() WHERE id = ? AND tenant_id = ?').run(body.enabled === false ? 0 : 1, id, tenant.id)
    if (!result.changes) return NextResponse.json({ error: 'Profile not found for active tenant' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Profile update denied' }, { status: 403 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const tenant = requireProfileContext(user, request.nextUrl.searchParams.get('tenant_key'))
    if (!canMutateProfiles(tenant)) return NextResponse.json({ error: 'Tenant owner or admin role required' }, { status: 403 })
    const id = Number((await params).id)
    const db = getDatabase()
    const result = db.prepare('DELETE FROM tenant_model_profiles WHERE id = ? AND tenant_id = ?').run(id, tenant.id)
    if (!result.changes) return NextResponse.json({ error: 'Profile not found for active tenant' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Profile deletion denied' }, { status: 403 })
  }
}
