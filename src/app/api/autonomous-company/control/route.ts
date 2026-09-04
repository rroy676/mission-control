import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'

const CONTROL_URL = 'http://127.0.0.1:8765/api/control'

export async function POST(request: Request) {
  const auth = requireRole(request as any, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  let payload: unknown
  try { payload = await request.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }
  if (!payload || typeof payload !== 'object' || (payload as any).action !== 'pause' || (payload as any).requested_by !== 'CEO' || typeof (payload as any).reason !== 'string' || typeof (payload as any).request_id !== 'string') {
    return NextResponse.json({ error: 'only a bounded CEO pause request is accepted' }, { status: 400 })
  }
  const secret = process.env.MISSION_CONTROL_CONTROL_SECRET || process.env.API_KEY || ''
  if (!secret) return NextResponse.json({ error: 'Hermes control adapter unavailable' }, { status: 503 })
  try {
    const response = await fetch(CONTROL_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mission-control-control-secret': secret }, body: JSON.stringify(payload), cache: 'no-store' })
    const body = await response.json().catch(() => ({ error: 'invalid Hermes response' }))
    return NextResponse.json(body, { status: response.status })
  } catch { return NextResponse.json({ error: 'Hermes control adapter unavailable' }, { status: 503 }) }
}
