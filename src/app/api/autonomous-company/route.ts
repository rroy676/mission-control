import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { readCompanyObservability } from '@/lib/company-observability'

export async function GET(request: Request) {
  const auth = requireRole(request as any, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json(readCompanyObservability(), {
    headers: { 'Cache-Control': 'no-store' },
  })
}
