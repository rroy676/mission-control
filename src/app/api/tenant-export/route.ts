import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { createTenantExport } from '@/lib/tenant-export'
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin'); if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request); if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try { return NextResponse.json(createTenantExport(user, request.nextUrl.searchParams.get('tenant_key')), { status: 201 }) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Tenant export failed' }, { status: 403 }) }
}
