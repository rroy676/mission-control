import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { decideHermesApproval, getHermesBackgroundStatus } from '@/lib/hermes-background'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json(getHermesBackgroundStatus(auth.user.workspace_id), { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const body = await request.json().catch(() => null)
  if (!body || typeof body.approval_id !== 'string' || !['APPROVED', 'REJECTED'].includes(body.decision)) return NextResponse.json({ error: 'approval_id and decision are required' }, { status: 400 })
  try {
    return NextResponse.json(decideHermesApproval(body.approval_id, body.decision, auth.user.username, typeof body.note === 'string' ? body.note : '', auth.user.workspace_id))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Approval decision failed' }, { status: 404 })
  }
}
