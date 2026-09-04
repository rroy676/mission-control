import type Database from 'better-sqlite3'
import { MODEL_CATALOG } from '@/lib/models'
import { getDatabase } from '@/lib/db'
import type { User } from '@/lib/auth'
import { requireTenantContext, type TenantContext, type TenantMembershipRole } from '@/lib/tenant-context'

export type ProfileScope = 'tenant-default' | 'agent-override' | 'workflow-override' | 'task-override'
export type ProfilePurpose = 'general' | 'engineering' | 'chat' | 'workflow' | 'task'

export interface ModelCatalogEntry {
  provider_id: string
  model_id: string
  display_name: string
  enabled_globally: boolean
  context_window: number | null
  capabilities: Record<string, unknown>
  pricing_metadata: Record<string, unknown>
  promotional_free: boolean
  promotional_expires_at: number | null
  deprecated: boolean
}

export interface ModelProfile {
  id: number
  tenant_id: number
  provider_id: string
  model_id: string
  purpose: ProfilePurpose
  scope: ProfileScope
  agent_id: number | null
  workflow_id: number | null
  task_id: number | null
  enabled: boolean
  priority: number
  credential_ref: string | null
  fallback_profile_id: number | null
  promotional_free: boolean
  promotional_expires_at: number | null
  effective_from: number
  expires_at: number | null
  created_at: number
  updated_at: number
}

export interface EffectiveModel {
  provider_id: string
  model_id: string
  profile_id: number
  credential_ref: string | null
  resolution_source: ProfileScope
  fallback_chain: number[]
  promotional_free: boolean
  promotional_active: boolean
  reason_code: string
}

const MEMBERSHIP_LEVELS: Record<TenantMembershipRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }

export function requireProfileContext(user: User, requestedTenantKey?: string | null): TenantContext {
  const result = requireTenantContext(user, requestedTenantKey)
  if (result instanceof Response) throw new Error('Tenant context is missing or unauthorized')
  return result
}

export function canMutateProfiles(context: TenantContext): boolean {
  return MEMBERSHIP_LEVELS[context.membershipRole] >= MEMBERSHIP_LEVELS.admin
}

function parseJson(value: string | null | undefined): Record<string, unknown> {
  try { return value ? JSON.parse(value) : {} } catch { return {} }
}

export function getCatalog(db: Database.Database = getDatabase()): ModelCatalogEntry[] {
  const rows = db.prepare(`SELECT * FROM model_provider_catalog ORDER BY provider_id, model_id`).all() as any[]
  const known = new Map<string, ModelCatalogEntry>()
  for (const model of MODEL_CATALOG) {
    const [provider, ...parts] = model.name.split('/')
    known.set(`${provider}/${parts.join('/')}`, {
      provider_id: provider, model_id: parts.join('/'), display_name: model.description,
      enabled_globally: true, context_window: model.contextWindow ?? null,
      capabilities: { input_modalities: model.inputModalities ?? ['text'] }, pricing_metadata: { ...model.costPerMTok },
      promotional_free: false, promotional_expires_at: null, deprecated: false,
    })
  }
  for (const row of rows) known.set(`${row.provider_id}/${row.model_id}`, {
    provider_id: row.provider_id, model_id: row.model_id, display_name: row.display_name,
    enabled_globally: row.enabled_globally === 1, context_window: row.context_window ?? null,
    capabilities: parseJson(row.capabilities), pricing_metadata: parseJson(row.pricing_metadata),
    promotional_free: row.promotional_free === 1, promotional_expires_at: row.promotional_expires_at ?? null,
    deprecated: row.deprecated === 1,
  })
  return [...known.values()]
}

function catalogEntry(db: Database.Database, provider: string, model: string): ModelCatalogEntry | null {
  return getCatalog(db).find((entry) => entry.provider_id === provider && entry.model_id === model) || null
}

function profileFromRow(row: any): ModelProfile {
  return { ...row, enabled: row.enabled === 1, promotional_free: row.promotional_free === 1 }
}

export function listProfiles(context: TenantContext, db: Database.Database = getDatabase()): ModelProfile[] {
  return (db.prepare(`SELECT * FROM tenant_model_profiles WHERE tenant_id = ? ORDER BY scope, purpose, priority, id`).all(context.id) as any[]).map(profileFromRow)
}

function assertCredential(db: Database.Database, tenantId: number, provider: string, ref: string | null): void {
  if (!ref) return
  const row = db.prepare('SELECT 1 FROM tenant_credentials WHERE tenant_id = ? AND provider_id = ? AND credential_ref = ? AND status != ?').get(tenantId, provider, ref, 'revoked')
  if (!row) throw new Error('Credential reference is not configured for this tenant')
}

function assertTargetTenant(db: Database.Database, tenantId: number, scope: ProfileScope, agentId: number | null, workflowId: number | null, taskId: number | null): void {
  if (scope === 'agent-override' && agentId != null) {
    const row = db.prepare(`SELECT 1 FROM agents a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=? AND w.tenant_id=?`).get(agentId, tenantId)
    if (!row) throw new Error('Agent does not belong to active tenant')
  }
  if (scope === 'workflow-override' && workflowId != null) {
    const row = db.prepare('SELECT 1 FROM workflow_pipelines WHERE id=? AND workspace_id IN (SELECT id FROM workspaces WHERE tenant_id=?)').get(workflowId, tenantId)
    if (!row) throw new Error('Workflow does not belong to active tenant')
  }
  if (scope === 'task-override' && taskId != null) {
    const row = db.prepare('SELECT 1 FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=? AND w.tenant_id=?').get(taskId, tenantId)
    if (!row) throw new Error('Task does not belong to active tenant')
  }
}

export function saveProfile(context: TenantContext, input: Partial<ModelProfile>, db: Database.Database = getDatabase()): ModelProfile {
  const provider = String(input.provider_id || '').trim()
  const model = String(input.model_id || '').trim()
  const scope = (input.scope || 'tenant-default') as ProfileScope
  const purpose = (input.purpose || 'general') as ProfilePurpose
  if (!provider || !model || !['tenant-default', 'agent-override', 'workflow-override', 'task-override'].includes(scope)) throw new Error('Invalid model profile')
  if (!['general', 'engineering', 'chat', 'workflow', 'task'].includes(purpose)) throw new Error('Invalid profile purpose')
  const catalog = catalogEntry(db, provider, model)
  if (!catalog || !catalog.enabled_globally || catalog.deprecated) throw new Error('Model is not globally allowed')
  const now = Math.floor(Date.now() / 1000)
  const promoExpires = input.promotional_expires_at ?? catalog.promotional_expires_at
  assertCredential(db, context.id, provider, input.credential_ref ?? null)
  assertTargetTenant(db, context.id, scope, input.agent_id ?? null, input.workflow_id ?? null, input.task_id ?? null)
  if (input.fallback_profile_id != null) {
    const fallback = db.prepare('SELECT id FROM tenant_model_profiles WHERE id=? AND tenant_id=?').get(input.fallback_profile_id, context.id)
    if (!fallback) throw new Error('Fallback profile is not owned by active tenant')
  }
  const result = db.prepare(`
    INSERT INTO tenant_model_profiles
      (tenant_id, provider_id, model_id, purpose, scope, agent_id, workflow_id, task_id, enabled, priority, credential_ref, fallback_profile_id, promotional_free, promotional_expires_at, effective_from, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(context.id, provider, model, purpose, scope, input.agent_id ?? null, input.workflow_id ?? null, input.task_id ?? null, input.enabled === false ? 0 : 1, Number.isFinite(input.priority) ? input.priority : 100, input.credential_ref ?? null, input.fallback_profile_id ?? null, input.promotional_free ? 1 : 0, promoExpires, input.effective_from ?? now, input.expires_at ?? null, now)
  return profileFromRow(db.prepare('SELECT * FROM tenant_model_profiles WHERE id=? AND tenant_id=?').get(result.lastInsertRowid, context.id))
}

function validProfile(db: Database.Database, context: TenantContext, profile: ModelProfile, now: number): boolean {
  if (profile.tenant_id !== context.id || !profile.enabled || profile.effective_from > now || (profile.expires_at != null && profile.expires_at <= now)) return false
  if (profile.promotional_free && profile.promotional_expires_at != null && profile.promotional_expires_at <= now) return false
  const catalog = catalogEntry(db, profile.provider_id, profile.model_id)
  if (!catalog || !catalog.enabled_globally || catalog.deprecated) return false
  try { assertCredential(db, context.id, profile.provider_id, profile.credential_ref) } catch { return false }
  return true
}

export function resolveEffectiveModel(context: TenantContext, options: { agentId?: number; workflowId?: number; taskId?: number; purpose?: ProfilePurpose } = {}, db: Database.Database = getDatabase()): EffectiveModel | null {
  const purpose = options.purpose || 'general'
  const scopes: Array<{ scope: ProfileScope; target: number | undefined }> = [
    { scope: 'task-override', target: options.taskId }, { scope: 'workflow-override', target: options.workflowId },
    { scope: 'agent-override', target: options.agentId }, { scope: 'tenant-default', target: undefined },
  ]
  const now = Math.floor(Date.now() / 1000)
  const rows = (db.prepare(`SELECT * FROM tenant_model_profiles WHERE tenant_id=? AND purpose=? ORDER BY priority ASC, id ASC`).all(context.id, purpose) as any[]).map(profileFromRow)
  const seen = new Set<number>()
  const tryProfile = (profile: ModelProfile | undefined): EffectiveModel | null => {
    if (!profile || seen.has(profile.id)) return null
    seen.add(profile.id)
    if (!validProfile(db, context, profile, now)) return tryProfile(profile.fallback_profile_id ? rows.find((r) => r.id === profile.fallback_profile_id) : undefined)
    const fallbackChain: number[] = []
    let next = profile.fallback_profile_id
    while (next && fallbackChain.length < 10) {
      if (seen.has(next)) return null
      fallbackChain.push(next)
      const candidate = rows.find((r) => r.id === next)
      // `rows` is tenant-filtered. A missing candidate therefore means the
      // reference is foreign (or deleted); never expose or follow that id.
      if (!candidate) { fallbackChain.pop(); break }
      if (!validProfile(db, context, candidate, now)) { next = candidate.fallback_profile_id ?? null; continue }
      next = candidate.fallback_profile_id ?? null
    }
    return { provider_id: profile.provider_id, model_id: profile.model_id, profile_id: profile.id, credential_ref: profile.credential_ref, resolution_source: profile.scope, fallback_chain: fallbackChain, promotional_free: profile.promotional_free, promotional_active: profile.promotional_free && (!profile.promotional_expires_at || profile.promotional_expires_at > now), reason_code: profile.scope === 'tenant-default' ? 'tenant_default_selected' : 'override_selected' }
  }
  for (const choice of scopes) {
    if (choice.target == null && choice.scope !== 'tenant-default') continue
    const candidates = rows.filter((r) => r.scope === choice.scope && (choice.target == null || r.agent_id === choice.target || r.workflow_id === choice.target || r.task_id === choice.target))
    for (const candidate of candidates) { const result = tryProfile(candidate); if (result) return result }
  }
  return null
}

export function createCredentialReference(context: TenantContext, providerId: string, credentialRef: string, db: Database.Database = getDatabase()): void {
  if (!/^[a-z0-9][a-z0-9._/-]{1,119}$/.test(credentialRef)) throw new Error('Invalid credential reference')
  if (!providerId.trim()) throw new Error('Provider is required')
  db.prepare(`INSERT INTO tenant_credentials (tenant_id, credential_ref, provider_id, status) VALUES (?, ?, ?, 'unconfigured') ON CONFLICT(tenant_id, credential_ref) DO UPDATE SET provider_id=excluded.provider_id, updated_at=unixepoch()`).run(context.id, credentialRef, providerId)
}
