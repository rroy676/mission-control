import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { promoteMemory, rejectPromotion, promotionTypes } from '@/lib/durable-promotion'
import { z } from 'zod'

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('promote'), promotion_type: z.enum(promotionTypes), supersedes: z.string().max(200).nullable().optional() }).strict(),
  z.object({ action: z.literal('reject'), reason: z.string().trim().min(1).max(500) }).strict(),
])
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const user = getUserFromRequest(request); if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const body = bodySchema.parse(await request.json()), id = (await params).id, tenant = request.nextUrl.searchParams.get('tenant_key')
    return NextResponse.json(body.action === 'promote' ? { promotion: promoteMemory(user, id, body.promotion_type, tenant, body.supersedes) } : { promotion: rejectPromotion(user, id, body.reason, tenant) }, { status: body.action === 'promote' ? 201 : 200 })
  } catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? 'Invalid promotion payload' : error instanceof Error ? error.message : 'Promotion failed' }, { status: error instanceof z.ZodError ? 400 : 403 }) }
}
