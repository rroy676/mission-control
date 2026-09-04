import { describe, expect, it, vi, beforeEach } from 'vitest'
import { requireTenantContext, resolveTenantContext, selectTenantForSession } from '@/lib/tenant-context'

const auditRun = vi.fn()
const sessionRun = vi.fn()

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.includes('FROM tenant_memberships') && sql.includes('t.tenant_key')) {
          const key = args[1]
          return key === 'tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            ? { id: 1, tenant_key: 'tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', slug: 'alpha', display_name: 'Alpha', status: 'active', role: 'viewer' }
            : undefined
        }
        if (sql.includes('FROM tenant_memberships') && sql.includes('t.id')) {
          const id = args[1]
          return id === 1
            ? { id: 1, tenant_key: 'tnt_1_alpha', slug: 'alpha', display_name: 'Alpha', status: 'active', role: 'viewer' }
            : undefined
        }
        if (sql.includes('FROM workspaces')) return { id: 11 }
        return undefined
      },
      all: () => [],
      run: sql.includes('tenant_authorization_audit') ? auditRun : sessionRun,
    }),
  })),
}))

const user = {
  id: 7, username: 'alice', display_name: 'Alice', role: 'viewer' as const,
  workspace_id: 11, tenant_id: 1, created_at: 0, updated_at: 0, last_login_at: null,
  sessionId: 99,
}

describe('tenant context authorization', () => {
  beforeEach(() => {
    auditRun.mockClear()
    sessionRun.mockClear()
  })

  it('resolves an explicitly requested tenant only through membership', () => {
    const context = resolveTenantContext(user, 'tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(context?.tenantKey).toBe('tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(context?.membershipRole).toBe('viewer')
    expect(auditRun).toHaveBeenCalledWith(7, 'alice', 'tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tenant_context', 'allow', 'membership_verified')
  })

  it('denies forged, unknown, and cross-tenant identifiers', () => {
    expect(resolveTenantContext(user, 'tnt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBeNull()
    expect(resolveTenantContext(user, '1')).toBeNull()
    expect(auditRun).toHaveBeenCalledTimes(2)
    expect(auditRun.mock.calls.every((call) => call[5] === 'deny')).toBe(true)
  })

  it('fails closed when active tenant context is missing', async () => {
    const response = requireTenantContext({ ...user, tenant_id: 99 })
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(403)
  })

  it('changes only a session-backed active tenant after membership validation', () => {
    const selected = selectTenantForSession(user, 'tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(selected?.id).toBe(1)
    expect(sessionRun).toHaveBeenCalledWith(1, 11, 99, 7)
    expect(selectTenantForSession({ ...user, sessionId: undefined }, 'tnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
  })
})
