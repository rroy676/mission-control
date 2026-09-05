import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { exportPathForTenant, verifyExport } from '@/lib/tenant-export'
import fs from 'node:fs'
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer'); if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request); if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try { const file = exportPathForTenant(user, (await params).id, request.nextUrl.searchParams.get('tenant_key')); const check = verifyExport(file); return NextResponse.json({ export_id: (await params).id, status: check.valid ? 'completed' : 'invalid', size: fs.statSync(file).size, checksum_status: check.valid ? 'valid' : 'invalid' }) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Export not found' }, { status: 404 }) }
}
