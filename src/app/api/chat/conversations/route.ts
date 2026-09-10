import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { hermesSessionIdFor } from '@/lib/hermes-runtime'
import { resolveHermesProject } from '@/lib/hermes-coo'

/**
 * GET /api/chat/conversations - List conversations derived from messages
 * Query params: agent (filter by participant), limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const { searchParams } = new URL(request.url)
    const workspaceId = auth.user.workspace_id ?? 1

    const agent = searchParams.get('agent')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    const offset = parseInt(searchParams.get('offset') || '0')

    let query: string
    const params: any[] = []

    if (agent) {
      // Get conversations where this agent is a participant
      query = `
        SELECT
          m.conversation_id,
          MAX(m.created_at) as last_message_at,
          COUNT(*) as message_count,
          COUNT(DISTINCT m.from_agent) + COUNT(DISTINCT CASE WHEN m.to_agent IS NOT NULL THEN m.to_agent END) as participant_count,
          SUM(CASE WHEN m.to_agent = ? AND m.read_at IS NULL THEN 1 ELSE 0 END) as unread_count
        FROM messages m
        WHERE m.workspace_id = ? AND (m.from_agent = ? OR m.to_agent = ? OR m.to_agent IS NULL)
        GROUP BY m.conversation_id
        ORDER BY last_message_at DESC
        LIMIT ? OFFSET ?
      `
      params.push(agent, workspaceId, agent, agent, limit, offset)
    } else {
      query = `
        SELECT
          m.conversation_id,
          MAX(m.created_at) as last_message_at,
          COUNT(*) as message_count,
          COUNT(DISTINCT m.from_agent) + COUNT(DISTINCT CASE WHEN m.to_agent IS NOT NULL THEN m.to_agent END) as participant_count,
          0 as unread_count
        FROM messages m
        WHERE m.workspace_id = ?
        GROUP BY m.conversation_id
        ORDER BY last_message_at DESC
        LIMIT ? OFFSET ?
      `
      params.push(workspaceId, limit, offset)
    }

    const conversations = db.prepare(query).all(...params) as any[]

    // Prepare last message statement once (avoids N+1)
    const lastMsgStmt = db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ? AND workspace_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const withLastMessage = conversations.map((conv) => {
      const lastMsg = lastMsgStmt.get(conv.conversation_id, workspaceId) as any;

      const hermesSessionId = typeof conv.conversation_id === 'string' && conv.conversation_id.startsWith('hermes:')
        ? conv.conversation_id.slice('hermes:'.length)
        : null
      const hermesBinding = hermesSessionId
        ? db.prepare(`
            SELECT b.project_id, a.name as agent_name, p.name as project_name
            FROM hermes_runtime_bindings b
            JOIN agents a ON a.id = b.agent_id AND a.workspace_id = b.workspace_id
            LEFT JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
            WHERE b.tenant_id = ? AND b.workspace_id = ? AND b.hermes_session_id = ?
            LIMIT 1
          `).get(auth.user.tenant_id ?? 1, workspaceId, hermesSessionId) as { project_id: number | null; agent_name: string; project_name: string | null } | undefined
        : undefined

      return {
        ...conv,
        ...(hermesBinding ? {
          kind: 'hermes',
          agent_name: hermesBinding.agent_name,
          project_id: hermesBinding.project_id,
          project_name: hermesBinding.project_name,
        } : {}),
        last_message: lastMsg
          ? {
              ...lastMsg,
              metadata: lastMsg.metadata ? JSON.parse(lastMsg.metadata) : null
            }
          : null
      }
    })

    // Get total count for pagination
    let countQuery: string
    const countParams: any[] = [workspaceId]
    if (agent) {
      countQuery = `
        SELECT COUNT(DISTINCT m.conversation_id) as total
        FROM messages m
        WHERE m.workspace_id = ? AND (m.from_agent = ? OR m.to_agent = ? OR m.to_agent IS NULL)
      `
      countParams.push(agent, agent)
    } else {
      countQuery = 'SELECT COUNT(DISTINCT conversation_id) as total FROM messages WHERE workspace_id = ?'
    }
    const countRow = db.prepare(countQuery).get(...countParams) as { total: number }

    return NextResponse.json({ conversations: withLastMessage, total: countRow.total, page: Math.floor(offset / limit) + 1, limit })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/chat/conversations error')
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 })
  }
}

/**
 * POST /api/chat/conversations - Create or reuse a server-owned Hermes chat
 * session for the authenticated tenant, agent, and optional project.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json()
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const tenantId = auth.user.tenant_id ?? 1
    const agentId = Number(body?.agent_id)
    const agentName = typeof body?.agent_name === 'string' ? body.agent_name.trim() : ''
    const projectId = body?.project_id === null || body?.project_id === '' || body?.project_id === undefined
      ? null
      : Number(body.project_id)

    if (!Number.isInteger(agentId) && !agentName) {
      return NextResponse.json({ error: 'A Hermes agent is required' }, { status: 400 })
    }
    if (projectId !== null && !Number.isInteger(projectId)) {
      return NextResponse.json({ error: 'Invalid project' }, { status: 400 })
    }

    const agent = Number.isInteger(agentId)
      ? db.prepare('SELECT id, name, runtime_type FROM agents WHERE id = ? AND workspace_id = ? AND hidden = 0').get(agentId, workspaceId) as { id: number; name: string; runtime_type?: string | null } | undefined
      : db.prepare('SELECT id, name, runtime_type FROM agents WHERE lower(name) = lower(?) AND workspace_id = ? AND hidden = 0').get(agentName, workspaceId) as { id: number; name: string; runtime_type?: string | null } | undefined

    if (!agent || String(agent.runtime_type || '').toLowerCase() !== 'hermes') {
      return NextResponse.json({ error: 'Selected agent is not an eligible Hermes runtime' }, { status: 400 })
    }

    const project = projectId === null ? null : resolveHermesProject(auth.user, projectId)
    const existing = db.prepare('SELECT hermes_session_id FROM hermes_runtime_bindings WHERE tenant_id = ? AND workspace_id = ? AND agent_id = ? AND project_id IS ?').get(tenantId, workspaceId, agent.id, projectId) as { hermes_session_id: string } | undefined
    const sessionId = existing?.hermes_session_id || hermesSessionIdFor(tenantId, workspaceId, agent.id, projectId)

    return NextResponse.json({
      conversation: {
        id: `hermes:${sessionId}`,
        session_id: sessionId,
        agent_id: agent.id,
        agent_name: agent.name,
        project_id: project?.id ?? null,
        project_name: project?.name ?? null,
      },
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/chat/conversations error')
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create conversation' }, { status: 400 })
  }
}
