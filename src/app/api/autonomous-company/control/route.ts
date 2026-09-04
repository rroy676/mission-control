import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { processPauseShadow } from '@/lib/authority/shadow'

export async function POST(request: Request) {
  const auth = requireRole(request as any, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  let payload: unknown
  try { payload = await request.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }
  const result = await processPauseShadow(payload, auth.user.username)
  return NextResponse.json(result, { status: result.mismatch ? 409 : result.allow ? 200 : 400 })
}
