import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { exportPathForTenant } from '@/lib/tenant-export'
import { logAuditEvent } from '@/lib/db'
import fs from 'node:fs'
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'admin'); if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request); if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try { const id = (await params).id, file = exportPathForTenant(user, id, request.nextUrl.searchParams.get('tenant_key')); logAuditEvent({ action: 'tenant_export_downloaded', actor: user.username, actor_id: user.id, target_type: 'tenant_export', detail: { export_id: id, tenant_id: user.tenant_id }, tenant_id: user.tenant_id, workspace_id: user.workspace_id }); return new NextResponse(fs.readFileSync(file), { headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${id}.tar.gz"`, 'Cache-Control': 'private, no-store' } }) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Export not found' }, { status: 404 }) }
}
