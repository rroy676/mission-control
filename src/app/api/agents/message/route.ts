import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { runOpenClaw } from '@/lib/command'
import { requireRole } from '@/lib/auth'
import { validateBody, createMessageSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { scanForInjection } from '@/lib/injection-guard'
import { scanForSecrets } from '@/lib/secret-scanner'
import { logSecurityEvent } from '@/lib/security-events'
import { HermesRuntimeError, recordHermesInteraction, sendHermesMessage } from '@/lib/hermes-runtime'
import { ensureTenantProjectAccess, ensureTenantWorkspaceAccess } from '@/lib/workspaces'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, createMessageSchema)
    if ('error' in result) return result.error
    const { to, message, project_id } = result.data
    const from = auth.user.display_name || auth.user.username || 'system'

    // Scan message for injection — this gets forwarded directly to an agent
    const injectionReport = scanForInjection(message, { context: 'prompt' })
    if (!injectionReport.safe) {
      const criticals = injectionReport.matches.filter(m => m.severity === 'critical')
      if (criticals.length > 0) {
        logger.warn({ to, rules: criticals.map(m => m.rule) }, 'Blocked agent message: injection detected')
        return NextResponse.json(
          { error: 'Message blocked: potentially unsafe content detected', injection: criticals.map(m => ({ rule: m.rule, description: m.description })) },
          { status: 422 }
        )
      }
    }

    const secretHits = scanForSecrets(message)
    if (secretHits.length > 0) {
      try { logSecurityEvent({ event_type: 'secret_exposure', severity: 'critical', source: 'agent-message', agent_name: from, detail: JSON.stringify({ count: secretHits.length, types: secretHits.map(s => s.type) }), workspace_id: auth.user.workspace_id ?? 1, tenant_id: 1 }) } catch {}
    }

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1;
    ensureTenantWorkspaceAccess(db, auth.user.tenant_id, workspaceId, { actor: auth.user.username, actorId: auth.user.id, route: '/api/agents/message' })
    const agent = db
      .prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?')
      .get(to, workspaceId) as any
    if (!agent) {
      return NextResponse.json({ error: 'Recipient agent not found' }, { status: 404 })
    }
    const runtime = typeof agent.runtime_type === 'string' ? agent.runtime_type.toLowerCase() : ''
    if (!runtime) return NextResponse.json({ error: 'Unsupported agent runtime' }, { status: 400 })
    let projectId: number | null = null
    if (project_id !== undefined) {
      try {
        ensureTenantProjectAccess(db, auth.user.tenant_id, project_id, { actor: auth.user.username, actorId: auth.user.id, route: '/api/agents/message' })
        const project = db.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND status = 'active'").get(project_id, workspaceId) as { id: number } | undefined
        if (!project) return NextResponse.json({ error: 'Project context invalid' }, { status: 403 })
        projectId = project.id
      } catch { return NextResponse.json({ error: 'Project context invalid' }, { status: 403 }) }
    }

    if (runtime === 'hermes') {
      try {
        const delivered = await sendHermesMessage({ tenantId: auth.user.tenant_id, workspaceId, agentId: agent.id, projectId, message: `Message from ${from}: ${message}`, actor: from, actorUser: auth.user })
        recordHermesInteraction({ tenantId: auth.user.tenant_id, workspaceId, agentId: agent.id, projectId, actor: from, message, response: delivered.response, sessionId: delivered.sessionId })
        db_helpers.createNotification(to, 'message', 'Direct Message', `Hermes: ${delivered.response.substring(0, 200)}${delivered.response.length > 200 ? '...' : ''}`, 'agent', agent.id, workspaceId)
        db_helpers.logActivity('agent_message', 'agent', agent.id, from, `Sent message to ${to} via Hermes`, { to, runtime: 'hermes', project_id: projectId, hermes_session_id: delivered.sessionId }, workspaceId)
        return NextResponse.json({ success: true, response: delivered.response })
      } catch (error) {
        if (error instanceof HermesRuntimeError) return NextResponse.json({ error: error.message }, { status: error.status })
        throw error
      }
    }
    if (runtime !== 'openclaw') return NextResponse.json({ error: 'Unsupported agent runtime' }, { status: 400 })
    if (!agent.session_key) {
      return NextResponse.json(
        { error: 'Recipient agent has no session key configured' },
        { status: 400 }
      )
    }

    await runOpenClaw(
      [
        'gateway',
        'sessions_send',
        '--session',
        agent.session_key,
        '--message',
        `Message from ${from}: ${message}`
      ],
      { timeoutMs: 10000 }
    )

    db_helpers.createNotification(
      to,
      'message',
      'Direct Message',
      `${from}: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`,
      'agent',
      agent.id,
      workspaceId
    )

    db_helpers.logActivity(
      'agent_message',
      'agent',
      agent.id,
      from,
      `Sent message to ${to}`,
      { to },
      workspaceId
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/message error')
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}
