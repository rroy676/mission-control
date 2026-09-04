import { NextResponse } from 'next/server'
import type Database from 'better-sqlite3'
import type { User } from '@/lib/auth'
import { getDatabase } from '@/lib/db'

export type TenantMembershipRole = 'owner' | 'admin' | 'operator' | 'viewer'

export interface TenantContext {
  id: number
  tenantKey: string
  slug: string
  displayName: string
  status: string
  membershipRole: TenantMembershipRole
  userId: number
}

interface TenantRow {
  id: number
  tenant_key: string
  slug: string
  display_name: string
  status: string
  role: TenantMembershipRole
}

function auditTenantDecision(
  db: Database.Database,
  user: User,
  requestedTenantKey: string | null,
  effectiveTenantKey: string | null,
  operationClass: string,
  decision: 'allow' | 'deny',
  reasonCode: string,
): void {
  try {
    db.prepare(`
      INSERT INTO tenant_authorization_audit
        (actor_user_id, actor, requested_tenant_key, effective_tenant_key, operation_class, decision, reason_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.id > 0 ? user.id : null, user.username || 'unknown', requestedTenantKey, effectiveTenantKey, operationClass, decision, reasonCode)
  } catch {
    // Authorization decisions must not depend on audit availability.
  }
}

function membershipForKey(db: Database.Database, userId: number, tenantKey: string): TenantRow | null {
  return db.prepare(`
    SELECT t.id, t.tenant_key, t.slug, t.display_name, t.status, tm.role
    FROM tenant_memberships tm
    JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.user_id = ? AND t.tenant_key = ? AND t.status != 'decommissioned'
    LIMIT 1
  `).get(userId, tenantKey) as TenantRow | undefined || null
}

function membershipForId(db: Database.Database, userId: number, tenantId: number): TenantRow | null {
  return db.prepare(`
    SELECT t.id, t.tenant_key, t.slug, t.display_name, t.status, tm.role
    FROM tenant_memberships tm
    JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.user_id = ? AND t.id = ? AND t.status != 'decommissioned'
    LIMIT 1
  `).get(userId, tenantId) as TenantRow | undefined || null
}

export function listAuthorizedTenants(user: User): Array<TenantContext & { active: boolean }> {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT t.id, t.tenant_key, t.slug, t.display_name, t.status, tm.role
    FROM tenant_memberships tm
    JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.user_id = ? AND t.status != 'decommissioned'
    ORDER BY t.display_name COLLATE NOCASE
  `).all(user.id) as TenantRow[]
  return rows.map((row) => ({ id: row.id, tenantKey: row.tenant_key, slug: row.slug, displayName: row.display_name, status: row.status, membershipRole: row.role, userId: user.id, active: row.id === user.tenant_id }))
}

/** Resolve only from authenticated membership and the session's active tenant. */
export function resolveTenantContext(user: User, requestedTenantKey?: string | null): TenantContext | null {
  const db = getDatabase()
  const requested = requestedTenantKey?.trim() || null
  const row = requested
    ? membershipForKey(db, user.id, requested)
    : membershipForId(db, user.id, user.tenant_id)
  if (!row) {
    auditTenantDecision(db, user, requested, null, 'tenant_context', 'deny', requested ? 'tenant_not_authorized' : 'active_tenant_missing')
    return null
  }
  auditTenantDecision(db, user, requested, row.tenant_key, 'tenant_context', 'allow', requested ? 'membership_verified' : 'active_session_tenant')
  return { id: row.id, tenantKey: row.tenant_key, slug: row.slug, displayName: row.display_name, status: row.status, membershipRole: row.role, userId: user.id }
}

export function requireTenantContext(user: User, requestedTenantKey?: string | null): TenantContext | NextResponse {
  const context = resolveTenantContext(user, requestedTenantKey)
  if (!context) return NextResponse.json({ error: 'Tenant context is missing or unauthorized' }, { status: 403 })
  return context
}

export function selectTenantForSession(user: User, tenantKey: string): TenantContext | null {
  if (!user.sessionId || user.id <= 0) return null
  const db = getDatabase()
  const context = resolveTenantContext(user, tenantKey)
  if (!context) return null
  const workspace = db.prepare(`SELECT id FROM workspaces WHERE tenant_id = ? ORDER BY id LIMIT 1`).get(context.id) as { id: number } | undefined
  if (!workspace) return null
  db.prepare(`UPDATE user_sessions SET tenant_id = ?, workspace_id = ? WHERE id = ? AND user_id = ?`).run(context.id, workspace.id, user.sessionId, user.id)
  return context
}

