import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { continueHermesTaskOnce, getHermesBackgroundStatus, setHermesContinuation } from '@/lib/hermes-background'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const taskId = Number(request.nextUrl.searchParams.get('task_id'))
  if (!Number.isInteger(taskId) || taskId < 1) return NextResponse.json({ error: 'task_id is required' }, { status: 400 })
  try {
    const continuation = getHermesBackgroundStatus(auth.user.workspace_id).continuations.find((row: any) => row.task_id === taskId)
    return NextResponse.json({ continuation: continuation || null })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Continuation unavailable' }, { status: 404 }) }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const body = await request.json().catch(() => null)
  const taskId = Number(body?.task_id)
  const action = body?.action
  if (!Number.isInteger(taskId) || taskId < 1 || !['enable', 'disable', 'continue_once'].includes(action)) return NextResponse.json({ error: 'task_id and action (enable, disable, continue_once) are required' }, { status: 400 })
  try {
    if (action === 'continue_once') return NextResponse.json(await continueHermesTaskOnce(taskId, auth.user.workspace_id))
    return NextResponse.json({ continuation: setHermesContinuation(taskId, auth.user.workspace_id, action === 'enable') })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Continuation control failed' }, { status: 400 }) }
}
