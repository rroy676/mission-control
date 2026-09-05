import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { config } from './config'
import { getDatabase, logAuditEvent } from './db'
import { requireTenantContext, type TenantContext } from './tenant-context'
import { rejectSecrets } from './portable-memory'
import type { User } from './auth'

export const promotionTypes = ['ceo_decision', 'governance_change', 'architecture_decision', 'incident', 'lesson_learned', 'durable_project_state', 'operational_acceptance', 'material_finance_decision', 'material_growth_decision'] as const
export type PromotionType = typeof promotionTypes[number]
const typePrefix: Record<PromotionType, string> = { ceo_decision: 'CEO', governance_change: 'GOV', architecture_decision: 'DEC', incident: 'INC', lesson_learned: 'LESSON', durable_project_state: 'STATE', operational_acceptance: 'OPS', material_finance_decision: 'FIN', material_growth_decision: 'GROWTH' }
const folder: Record<PromotionType, string> = { ceo_decision: '00-CEO', governance_change: '09-Governance', architecture_decision: '02-Decisions', incident: '07-Operations', lesson_learned: '08-Intelligence', durable_project_state: '04-Projects', operational_acceptance: '07-Operations', material_finance_decision: '05-Finance', material_growth_decision: '06-Growth' }
const eligibleMemoryTypes = new Set(['promotion_candidate', 'recent_decision', 'incident_context', 'lesson_candidate', 'current_state', 'product_context'])
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'record'
const tenantSafe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

function context(user: User, requested?: string | null): TenantContext {
  const result = requireTenantContext(user, requested)
  if (!('id' in result)) throw new Error('Tenant context is missing or unauthorized')
  return result
}
function rowMemory(db: Database.Database, tenant: TenantContext, memoryId: string): any {
  const row = db.prepare(`SELECT wm.*, t.tenant_key FROM working_memory wm JOIN tenants t ON t.id=wm.tenant_id WHERE wm.tenant_id=? AND wm.memory_id=?`).get(tenant.id, memoryId)
  if (!row) throw new Error('Memory not found for active tenant')
  return row
}
function eligible(row: any, type: PromotionType): boolean {
  if (!eligibleMemoryTypes.has(row.memory_type)) return false
  if (type === 'ceo_decision') return row.memory_type === 'recent_decision' || row.memory_type === 'promotion_candidate'
  if (type === 'incident') return row.memory_type === 'incident_context' || /\bincident\b/i.test(`${row.title} ${row.content}`)
  if (type === 'lesson_learned') return row.memory_type === 'lesson_candidate'
  if (type === 'durable_project_state') return row.memory_type === 'current_state' || row.memory_type === 'product_context'
  return true
}
function audit(user: User, tenant: TenantContext, action: string, row: any, detail: Record<string, unknown>) {
  logAuditEvent({ action, actor: user.username, actor_id: user.id, target_type: 'working_memory', target_id: 0, tenant_id: tenant.id, workspace_id: user.workspace_id, detail: { tenant_key: tenant.tenantKey, memory_id: row.memory_id, ...detail } })
}
function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function gitCommit(repo: string, relativePath: string, message: string): string {
  git(repo, ['add', '--', relativePath])
  const staged = git(repo, ['diff', '--cached', '--name-only', '--', relativePath])
  if (staged !== relativePath) throw new Error('durable promotion staging boundary is unsafe')
  git(repo, ['commit', '--only', '-m', message, '--', relativePath])
  return git(repo, ['rev-parse', 'HEAD'])
}
function markdown(row: any, tenant: TenantContext, durableId: string, type: PromotionType, promotedAt: number, actor: string, sourceHash: string, supersedes?: string | null): string {
  rejectSecrets(row)
  const tags = JSON.parse(row.metadata || '{}')?.tags
  const safeTags = Array.isArray(tags) ? tags.filter((x: unknown) => typeof x === 'string').slice(0, 20) : [type]
  const front = { schema_version: 'durable-memory-1.0', durable_id: durableId, tenant_id: tenant.id, tenant_key: tenant.tenantKey, type, title: row.title, status: 'promoted', source_memory_id: row.memory_id, source_project_id: row.project_id, created_at: iso(row.created_at), promoted_at: iso(promotedAt), promoted_by: actor, supersedes: supersedes || null, importance: row.importance, tags: safeTags, source_references: JSON.parse(row.source_references || '[]').slice(0, 20), audit_reference: `memory:${row.memory_id}`, source_hash: sourceHash }
  const yaml = Object.entries(front).map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`).join('\n')
  return `---\n${yaml}\n---\n\n# ${row.title}\n\n${row.content.trim()}\n\n_Source: Mission Control working memory ${row.memory_id}; durable promotion is an explicit bounded action._\n`
}

export function promoteMemory(user: User, memoryId: string, type: PromotionType, requestedTenantKey?: string | null, supersedes?: string | null) {
  const tenant = context(user, requestedTenantKey), db = getDatabase(), row = rowMemory(db, tenant, memoryId)
  if (!promotionTypes.includes(type)) throw new Error('Unsupported promotion type')
  if (!eligible(row, type)) { audit(user, tenant, 'memory_promotion_denied', row, { decision: 'ineligible', promotion_type: type }); throw new Error('Memory is not eligible for this durable promotion type') }
  if (type === 'ceo_decision' && tenant.membershipRole !== 'owner') { audit(user, tenant, 'memory_promotion_denied', row, { decision: 'ceo_authority_required', promotion_type: type }); throw new Error('Owner authority is required for CEO decision promotion') }
  const existing = db.prepare(`SELECT * FROM durable_promotions WHERE tenant_id=? AND memory_id=? AND state='promoted' ORDER BY id DESC LIMIT 1`).get(tenant.id, memoryId) as any
  if (existing) return { state: 'promoted', durable_id: existing.durable_id, durable_path: existing.durable_path, durable_commit_sha: existing.commit_sha, idempotent: true }
  const sourceHash = createHash('sha256').update(JSON.stringify({ title: row.title, content: row.content, type, metadata: row.metadata })).digest('hex')
  const durableId = `${typePrefix[type]}-${tenantSafe(tenant.tenantKey)}-${new Date(row.created_at * 1000).toISOString().slice(0, 10).replaceAll('-', '')}-${slug(row.memory_id.slice(4, 16))}`
  const relativePath = path.posix.join('Software-Studio', folder[type], 'tenants', tenantSafe(tenant.tenantKey), `${durableId}-${slug(row.title)}.md`)
  const archiveFile = path.join(config.durableRepoRoot, relativePath)
  if (fs.existsSync(archiveFile)) throw new Error('Durable ID collision; explicit collision resolution is required')
  if (git(config.durableRepoRoot, ['status', '--porcelain', '--', relativePath])) throw new Error('durable target has unrelated working-tree changes')
  const promotedAt = Math.floor(Date.now() / 1000)
  const content = markdown(row, tenant, durableId, type, promotedAt, user.username, sourceHash, supersedes)
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(archiveFile, content, { encoding: 'utf8', mode: 0o600 })
  let sha: string
  try { sha = gitCommit(config.durableRepoRoot, relativePath, `memory: promote ${durableId}`) } catch (error) { try { fs.unlinkSync(archiveFile) } catch {} ; audit(user, tenant, 'memory_promotion_failed', row, { decision: 'blocked', failure_reason: error instanceof Error ? error.message : 'git failure' }); throw error }
  db.prepare(`INSERT INTO durable_promotions (tenant_id,memory_id,durable_id,durable_path,promotion_type,state,source_hash,supersedes,actor,actor_id,commit_sha) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(tenant.id, memoryId, durableId, relativePath, type, 'promoted', sourceHash, supersedes || null, user.username, user.id, sha)
  db.prepare(`UPDATE working_memory SET promotion_status='promoted', promotion_state='promoted', durable_id=?, durable_path=?, durable_commit_sha=?, promoted_at=?, promoted_by=?, promotion_type=?, durable_reference=?, updated_at=unixepoch() WHERE tenant_id=? AND memory_id=?`).run(durableId, relativePath, sha, promotedAt, user.username, type, relativePath, tenant.id, memoryId)
  audit(user, tenant, 'memory_promoted', row, { decision: 'promoted', durable_id: durableId, durable_path: relativePath, promotion_type: type, commit_sha: sha })
  return { state: 'promoted', durable_id: durableId, durable_path: relativePath, durable_commit_sha: sha, idempotent: false }
}
export function rejectPromotion(user: User, memoryId: string, reason: string, requestedTenantKey?: string | null) {
  const tenant = context(user, requestedTenantKey), db = getDatabase(), row = rowMemory(db, tenant, memoryId)
  if (tenant.membershipRole !== 'owner' && tenant.membershipRole !== 'admin') throw new Error('Owner or admin authority is required')
  if (!reason || reason.length > 500) throw new Error('A bounded rejection reason is required')
  db.prepare(`INSERT INTO durable_promotions (tenant_id,memory_id,durable_id,durable_path,promotion_type,state,source_hash,actor,actor_id,reason) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(tenant.id, memoryId, `REJECTED-${memoryId}`, '', 'rejected', 'rejected', 'rejected', user.username, user.id, reason)
  db.prepare(`UPDATE working_memory SET promotion_state='rejected', updated_at=unixepoch() WHERE tenant_id=? AND memory_id=?`).run(tenant.id, memoryId)
  audit(user, tenant, 'memory_promotion_rejected', row, { decision: 'rejected', reason }); return { state: 'rejected', memory_id: memoryId }
}
