import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { readCompanyObservability } from '@/lib/company-observability'
import { readAuthorityShadowState } from '@/lib/authority/state'

export async function GET(request: Request) {
  const auth = requireRole(request as any, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const status = readCompanyObservability()
  const shadow = readAuthorityShadowState()
  return NextResponse.json({ ...status, company: { ...status.company, dispatch_mode: shadow.dispatch_mode !== 'UNKNOWN' ? shadow.dispatch_mode : status.company.dispatch_mode, authority_shadow: shadow.last_request } }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
