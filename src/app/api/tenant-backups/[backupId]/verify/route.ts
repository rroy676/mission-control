import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest, requireRole } from '@/lib/auth'
import { verifyTenantBackup } from '@/lib/tenant-backups'

export async function POST(request: NextRequest, { params }: { params: Promise<{ backupId: string }> }) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const { backupId } = await params
    return NextResponse.json(verifyTenantBackup(user, backupId, request.nextUrl.searchParams.get('tenant_key')))
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Restore verification failed' }, { status: 403 }) }
}
