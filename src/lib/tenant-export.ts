import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { config } from './config'
import { getDatabase, logAuditEvent } from './db'
import { requireTenantContext, type TenantContext } from './tenant-context'
import type { User } from './auth'

export const EXPORT_SCHEMA_VERSION = 'tenant-export-1.0'
const secret = /(api[_ -]?key|password|passwd|session[_ -]?cookie|bearer\s+token|access[_ -]?token|secret|private[_ -]?key)\s*[:=]|-----BEGIN.*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b/i
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
const safe = (value: unknown): unknown => {
  const text = JSON.stringify(value)
  if (secret.test(text)) throw new Error('Export contains a secret-like value')
  return value
}
function ctx(user: User, requested?: string | null): TenantContext { const result = requireTenantContext(user, requested); if (!('id' in result)) throw new Error('Tenant context is missing or unauthorized'); return result }
function tableExists(db: Database.Database, name: string) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) }
function columns(db: Database.Database, name: string) { return new Set((db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((x) => x.name)) }
function selectTenant(db: Database.Database, table: string, tenant: TenantContext, extra = ''): any[] {
  if (!tableExists(db, table)) return []
  const cols = columns(db, table)
  const order = extra && ((/created_at/.test(extra) && !cols.has('created_at')) || (/occurred_at/.test(extra) && !cols.has('occurred_at')) || (/\bid\b/.test(extra) && !cols.has('id'))) ? '' : extra
  if (cols.has('tenant_id')) return db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ${order}`).all(tenant.id) as any[]
  if (cols.has('workspace_id')) return db.prepare(`SELECT x.* FROM ${table} x JOIN workspaces w ON w.id=x.workspace_id WHERE w.tenant_id=? ${order}`).all(tenant.id) as any[]
  return []
}
function redactRows(rows: any[]): any[] { return rows.map((row) => { const copy = { ...row }; for (const key of Object.keys(copy)) if (/password|token|cookie|secret|private_key|api_key/i.test(key)) delete copy[key]; return safe(copy) as any }) }
function writeFile(root: string, relative: string, content: string) { const target = path.resolve(root, relative); if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Export path escaped root'); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, content, { mode: 0o600 }); return target }
function checksums(root: string): string {
  const files: string[] = []
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name !== 'checksums.txt') files.push(path.relative(root, full).split(path.sep).join('/')) } }
  walk(root); files.sort(); return files.map((file) => `${createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}  ${file}`).join('\n') + '\n'
}
function scanExportSecrets(root: string): void {
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name !== 'checksums.txt' && secret.test(fs.readFileSync(full, 'utf8'))) throw new Error(`Export contains a secret-like value in ${path.relative(root, full)}`) } }
  walk(root)
}
function archive(root: string, output: string, rootName: string) { execFileSync('tar', ['-czf', output, '-C', path.dirname(root), rootName], { stdio: ['ignore', 'ignore', 'pipe'] }) }
export function verifyExport(archivePath: string): { valid: boolean; reason?: string; files?: string[] } {
  const scratch = fs.mkdtempSync(path.join(config.dataDir, 'export-validate-'))
  try {
    const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)
    if (listing.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('Archive contains a traversal path')
    execFileSync('tar', ['-xzf', archivePath, '-C', scratch], { stdio: ['ignore', 'ignore', 'pipe'] })
    const roots = fs.readdirSync(scratch, { withFileTypes: true }).filter((x) => x.isDirectory())
    if (roots.length !== 1 || !/^tenant-export-/.test(roots[0].name)) throw new Error('Export root structure is invalid')
    const root = path.join(scratch, roots[0].name), manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')), lines = fs.readFileSync(path.join(root, 'checksums.txt'), 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) { const [expected, relative] = line.split(/\s{2}/); const target = path.resolve(root, relative); if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) throw new Error('Checksum path is invalid or missing'); const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex'); if (actual !== expected) throw new Error(`Checksum mismatch: ${relative}`) }
    if (manifest.checksum_algorithm !== 'sha256' || !manifest.export_schema_version) throw new Error('Manifest is invalid')
    if (lines.some((line) => !listing.includes(`${roots[0].name}/${line.split(/\s{2}/)[1]}`))) throw new Error('Checksum file references a file outside the archive')
    return { valid: true, files: lines.map((line) => line.split(/\s{2}/)[1]) }
  } catch (error) { return { valid: false, reason: error instanceof Error ? error.message : 'Export validation failed' } } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
export function createTenantExport(user: User, requestedTenantKey?: string | null) {
  const tenant = ctx(user, requestedTenantKey), db = getDatabase(); fs.mkdirSync(config.exportDir, { recursive: true, mode: 0o700 })
  const exportId = `exp_${randomUUID()}`, timestamp = Math.floor(Date.now() / 1000), rootName = `tenant-export-${tenantSafe(tenant.tenantKey)}-${timestamp}`, root = path.join(config.exportDir, exportId, rootName)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  try {
    const memories = db.prepare(`SELECT wm.*, t.tenant_key FROM working_memory wm JOIN tenants t ON t.id=wm.tenant_id WHERE wm.tenant_id=? ORDER BY wm.updated_at, wm.memory_id`).all(tenant.id) as any[]
    const projects = selectTenant(db, 'projects', tenant), agents = selectTenant(db, 'agents', tenant), handoffs = memories.filter((x) => x.memory_type === 'handoff')
    const audit = selectTenant(db, 'audit_log', tenant, 'ORDER BY created_at, id'), approvals = selectTenant(db, 'access_requests', tenant, 'ORDER BY created_at, id')
    const usage = tableExists(db, 'tenant_model_usage') ? selectTenant(db, 'tenant_model_usage', tenant, 'ORDER BY occurred_at, id') : selectTenant(db, 'token_usage', tenant, 'ORDER BY created_at, id')
    const profiles = tableExists(db, 'tenant_model_profiles') ? (db.prepare('SELECT tenant_id, provider_id, model_id, purpose, scope, agent_id, workflow_id, task_id, enabled, priority, credential_ref, fallback_profile_id, promotional_free, promotional_expires_at, effective_from, expires_at, created_at, updated_at FROM tenant_model_profiles WHERE tenant_id=? ORDER BY id').all(tenant.id) as any[]) : []
    const memoryPayload = memories.map((row) => { const copy = { ...row }; delete copy.id; delete copy.tenant_id; delete copy.metadata; copy.tenant_id = tenant.tenantKey; copy.metadata = JSON.parse(row.metadata || '{}'); return safe(copy) })
    const configPayload = safe({ tenant: { tenant_id: tenant.id, tenant_key: tenant.tenantKey, slug: tenant.slug, display_name: tenant.displayName, status: tenant.status }, model_profiles: profiles, credential_references: profiles.map((p) => p.credential_ref).filter(Boolean), exclusions: ['runtime credential values', 'cookies', 'private keys'] })
    const files: Record<string, string> = { 'memory.jsonl': jsonl(memoryPayload), 'projects.json': JSON.stringify(redactRows(projects), null, 2) + '\n', 'agents.json': JSON.stringify(redactRows(agents), null, 2) + '\n', 'handoffs.jsonl': jsonl(handoffs.map((x) => safe({ ...x, tenant_id: tenant.tenantKey }))), 'audit.jsonl': jsonl(redactRows(audit).map((x) => ({ ...x, tenant_id: tenant.tenantKey }))), 'approvals.jsonl': jsonl(redactRows(approvals).map((x) => ({ ...x, tenant_id: tenant.tenantKey }))), 'configuration.json': JSON.stringify(configPayload, null, 2) + '\n', 'cost-usage.jsonl': jsonl(redactRows(usage).map((x) => ({ ...x, tenant_id: tenant.tenantKey }))), 'finance-metadata.json': JSON.stringify({ schema_version: 'finance-metadata-1.0', configured_ledger_type: null, currency: null, tax_region: null, integration_references: [], source_of_truth: 'approved Finance ledger', last_known_synchronization: null }, null, 2) + '\n' }
    const durable = path.resolve(config.durableArchiveRoot); if (fs.existsSync(durable)) { const destination = path.join(root, 'durable-memory'); const candidate = path.join(durable, 'tenants', tenantSafe(tenant.tenantKey)); if (fs.existsSync(candidate)) fs.cpSync(candidate, destination, { recursive: true, mode: 0o600 }) }
    for (const [file, content] of Object.entries(files)) writeFile(root, file, content)
    scanExportSecrets(root)
    const counts = { memory: memories.length, projects: projects.length, agents: agents.length, handoffs: handoffs.length, audit: audit.length, approvals: approvals.length, cost_usage: usage.length, durable_memory: fs.existsSync(path.join(root, 'durable-memory')) ? fs.readdirSync(path.join(root, 'durable-memory'), { recursive: true }).filter((x) => String(x).endsWith('.md')).length : 0 }
    writeFile(root, 'manifest.json', JSON.stringify({ export_schema_version: EXPORT_SCHEMA_VERSION, export_id: exportId, tenant_id: tenant.id, tenant_key: tenant.tenantKey, created_at: new Date(timestamp * 1000).toISOString(), created_by: user.username, mission_control_version: process.env.MISSION_CONTROL_COMMIT || 'unknown', record_counts: counts, durable_archive_schema_version: 'durable-memory-1.0', checksum_algorithm: 'sha256', encryption_status: 'not-encrypted-local-protected', exclusions: ['cloud backup', 'raw credentials', 'runtime secrets'], compatibility: { format: 'portable-jsonl-markdown', validator: 'Mission Control verifyExport' } }, null, 2) + '\n')
    writeFile(root, 'checksums.txt', checksums(root)); const output = path.join(config.exportDir, `${exportId}.tar.gz`); archive(root, output, rootName); const validation = verifyExport(output); if (!validation.valid) throw new Error(validation.reason || 'Export validation failed')
    logAuditEvent({ action: 'tenant_export_created', actor: user.username, actor_id: user.id, target_type: 'tenant_export', detail: { export_id: exportId, tenant_key: tenant.tenantKey, counts }, tenant_id: tenant.id, workspace_id: user.workspace_id })
    return { export_id: exportId, status: 'completed', created_at: timestamp, size: fs.statSync(output).size, checksum_status: 'valid', counts, path: output }
  } catch (error) { fs.rmSync(path.join(config.exportDir, exportId), { recursive: true, force: true }); throw error }
}
function tenantSafe(value: string) { return value.replace(/[^a-zA-Z0-9_-]/g, '_') }
export function exportPathForTenant(user: User, exportId: string, requestedTenantKey?: string | null) { const tenant = ctx(user, requestedTenantKey), safeId = exportId.replace(/[^a-zA-Z0-9_-]/g, ''); if (safeId !== exportId) throw new Error('Invalid export id'); const file = path.join(config.exportDir, `${safeId}.tar.gz`); if (!fs.existsSync(file)) throw new Error('Export not found for active tenant'); const manifestRoot = verifyExport(file); if (!manifestRoot.valid) throw new Error('Export failed validation'); const listing = execFileSync('tar', ['-xOzf', file, '--wildcards', '*/manifest.json'], { encoding: 'utf8' }); if (!listing.includes(`"tenant_key": "${tenant.tenantKey}"`)) throw new Error('Export is not owned by active tenant'); return file }
