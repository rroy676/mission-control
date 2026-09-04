import { NextRequest, NextResponse } from 'next/server'
import { requireRole, getUserFromRequest } from '@/lib/auth'
import { updateHandoff } from '@/lib/working-memory'
import { z } from 'zod'
const body=z.object({status:z.enum(['pending','in_progress','completed','cancelled'])}).strict()
export async function PATCH(request:NextRequest,{params}:{params:Promise<{id:string}>}){const auth=requireRole(request,'operator');if('error'in auth)return NextResponse.json({error:auth.error},{status:auth.status});const user=getUserFromRequest(request);if(!user)return NextResponse.json({error:'Authentication required'},{status:401});try{const id=(await params).id;return NextResponse.json({handoff:updateHandoff(user,id,body.parse(await request.json()).status,request.nextUrl.searchParams.get('tenant_key'))})}catch(e){return NextResponse.json({error:e instanceof z.ZodError?'Invalid handoff status':e instanceof Error?e.message:'Handoff update failed'},{status:e instanceof z.ZodError?400:403})}}
