import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest, requireRole } from '@/lib/auth'
import { executeTenantBackup, getTenantBackupPolicy, listTenantBackups, updateTenantBackupPolicy } from '@/lib/tenant-backups'

function activeUser(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) }
  const user = getUserFromRequest(request)
  if (!user) return { response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) }
  return { user }
}

export async function GET(request: NextRequest) {
  const auth = activeUser(request); if ('response' in auth) return auth.response
  try {
    const tenantKey = request.nextUrl.searchParams.get('tenant_key')
    return NextResponse.json({ policy: getTenantBackupPolicy(auth.user, tenantKey), backups: listTenantBackups(auth.user, tenantKey) })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Backup access denied' }, { status: 403 }) }
}

export async function PUT(request: NextRequest) {
  const auth = activeUser(request); if ('response' in auth) return auth.response
  try {
    const body = await request.json().catch(() => ({}))
    return NextResponse.json({ policy: updateTenantBackupPolicy(auth.user, body, request.nextUrl.searchParams.get('tenant_key')) })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Backup policy update failed' }, { status: 403 }) }
}

export async function POST(request: NextRequest) {
  const auth = activeUser(request); if ('response' in auth) return auth.response
  try {
    const result = await executeTenantBackup(auth.user, request.nextUrl.searchParams.get('tenant_key'))
    return NextResponse.json(result, { status: 201 })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Backup failed' }, { status: 403 }) }
}
