import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { config } from './config'
import { createTenantExport } from './tenant-export'
import { getDatabase, logAuditEvent } from './db'
import { requireTenantContext, type TenantContext } from './tenant-context'
import { localFilesystemProvider, resolveBackupProvider, type BackupProvider } from './backup-provider'
import { BACKUP_FORMAT, decryptBackup, encryptBackup, inspectAndExtractPackage, packageExport, resolveBackupKey, sha256File, verifyExportArchive, type BackupMetadata } from './backup-format'
import type { User } from './auth'

const DEFAULT_POLICY = { enabled: false, local_snapshot_policy: 'portable-tenant-export', primary_provider: 'local-filesystem', secondary_provider: null, retention_count: 7, retention_period: 'daily', encryption_profile_ref: 'local-default', export_schedule: 'manual', backup_schedule: 'manual', integrity_check_schedule: 'manual', restore_test_schedule: 'manual', status: 'not_configured', failure_reason: null }

function tenant(user: User, requested?: string | null): TenantContext {
  const result = requireTenantContext(user, requested)
  if (!('id' in result)) throw new Error('Tenant context is missing or unauthorized')
  return result
}

function rowPolicy(tenantId: number): any {
  const db = getDatabase(), row = db.prepare('SELECT * FROM tenant_backup_policies WHERE tenant_id=?').get(tenantId)
  if (row) return row
  db.prepare(`INSERT INTO tenant_backup_policies (tenant_id, enabled, local_snapshot_policy, primary_provider, secondary_provider, retention_count, retention_period, encryption_profile_ref, export_schedule, backup_schedule, integrity_check_schedule, restore_test_schedule, status, failure_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tenantId, DEFAULT_POLICY.enabled ? 1 : 0, DEFAULT_POLICY.local_snapshot_policy, DEFAULT_POLICY.primary_provider, DEFAULT_POLICY.secondary_provider, DEFAULT_POLICY.retention_count, DEFAULT_POLICY.retention_period, DEFAULT_POLICY.encryption_profile_ref, DEFAULT_POLICY.export_schedule, DEFAULT_POLICY.backup_schedule, DEFAULT_POLICY.integrity_check_schedule, DEFAULT_POLICY.restore_test_schedule, DEFAULT_POLICY.status, DEFAULT_POLICY.failure_reason)
  return db.prepare('SELECT * FROM tenant_backup_policies WHERE tenant_id=?').get(tenantId)
}

export function getTenantBackupPolicy(user: User, requested?: string | null) { return rowPolicy(tenant(user, requested).id) }

export function updateTenantBackupPolicy(user: User, input: Record<string, unknown>, requested?: string | null) {
  const context = tenant(user, requested), current = rowPolicy(context.id)
  const allowed = ['enabled', 'primary_provider', 'secondary_provider', 'retention_count', 'retention_period', 'encryption_profile_ref', 'export_schedule', 'backup_schedule', 'integrity_check_schedule', 'restore_test_schedule']
  const next: Record<string, unknown> = {}
  for (const key of allowed) if (key in input) next[key] = input[key]
  if (next.primary_provider && next.primary_provider !== localFilesystemProvider.name) throw new Error('Only the local filesystem provider is configured')
  if (next.secondary_provider) throw new Error('Secondary provider is not configured')
  if (next.encryption_profile_ref && !/^[a-zA-Z0-9_-]{1,80}$/.test(String(next.encryption_profile_ref))) throw new Error('Invalid encryption profile reference')
  if (next.retention_count !== undefined && (!Number.isInteger(next.retention_count) || Number(next.retention_count) < 1 || Number(next.retention_count) > 365)) throw new Error('Retention count must be between 1 and 365')
  const db = getDatabase()
  const values = { ...current, ...next }
  db.prepare(`UPDATE tenant_backup_policies SET enabled=?, primary_provider=?, secondary_provider=?, retention_count=?, retention_period=?, encryption_profile_ref=?, export_schedule=?, backup_schedule=?, integrity_check_schedule=?, restore_test_schedule=?, updated_at=unixepoch(), status=CASE WHEN ?=1 THEN 'ready' ELSE 'disabled' END, failure_reason=NULL WHERE tenant_id=?`).run(values.enabled ? 1 : 0, values.primary_provider, values.secondary_provider || null, values.retention_count, values.retention_period, values.encryption_profile_ref, values.export_schedule, values.backup_schedule, values.integrity_check_schedule, values.restore_test_schedule, values.enabled ? 1 : 0, context.id)
  logAuditEvent({ action: 'tenant_backup_policy_updated', actor: user.username, actor_id: user.id, tenant_id: context.id, workspace_id: user.workspace_id, detail: { provider: values.primary_provider, encryption_profile_ref: values.encryption_profile_ref, enabled: Boolean(values.enabled) } })
  return rowPolicy(context.id)
}

export function listTenantBackups(user: User, requested?: string | null) {
  const context = tenant(user, requested)
  return getDatabase().prepare('SELECT * FROM tenant_backups WHERE tenant_id=? ORDER BY created_at DESC').all(context.id)
}

export async function runScheduledTenantBackups(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const policies = db.prepare("SELECT * FROM tenant_backup_policies WHERE enabled=1 AND backup_schedule != 'manual'").all() as any[]
  let completed = 0; const failures: string[] = []
  for (const policy of policies.slice(0, 20)) {
    const user = db.prepare(`SELECT u.* FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id WHERE tm.tenant_id=? AND tm.role IN ('owner','admin') ORDER BY CASE WHEN tm.role='owner' THEN 0 ELSE 1 END, u.id LIMIT 1`).get(policy.tenant_id) as User | undefined
    if (!user) { failures.push(`tenant ${policy.tenant_id}: no authorized service actor`); continue }
    try { await executeTenantBackup(user, undefined); completed++ } catch (error) { failures.push(`tenant ${policy.tenant_id}: ${error instanceof Error ? error.message : 'backup failed'}`) }
  }
  if (policies.length > 20) failures.push('schedule bound exceeded; remaining tenants deferred')
  return { ok: failures.length === 0, message: policies.length === 0 ? 'No tenant backup policies are due' : `Scheduled tenant backups: ${completed}/${policies.length}${failures.length ? `; ${failures.join(' | ')}` : ''}` }
}

function notifyFailure(context: TenantContext, workspaceId: number, title: string, message: string) {
  try { getDatabase().prepare(`INSERT INTO notifications (recipient, type, title, message, workspace_id) VALUES (?, 'backup_failure', ?, ?, ?)`).run('system', title, message.slice(0, 500), workspaceId) } catch {}
}

function updatePolicyStatus(tenantId: number, fields: Record<string, unknown>) {
  const entries = Object.keys(fields), values = entries.map((key) => fields[key])
  if (entries.length) getDatabase().prepare(`UPDATE tenant_backup_policies SET ${entries.map((key) => `${key}=?`).join(', ')}, updated_at=unixepoch() WHERE tenant_id=?`).run(...values, tenantId)
}

function retention(provider: BackupProvider, context: TenantContext, policy: any) {
  const rows = getDatabase().prepare('SELECT * FROM tenant_backups WHERE tenant_id=? ORDER BY created_at DESC').all(context.id) as any[]
  const keep = Math.max(1, Number(policy.retention_count) || 1)
  for (const row of rows.slice(keep)) {
    const verified = rows.filter((candidate) => candidate.restore_verification_status === 'verified' && candidate.retention_state !== 'pending_delete')
    if (verified.length <= 1 || row.restore_verification_status === 'verified' && verified.length <= 1) continue
    try { provider.delete(context.tenantKey, row.object_id); getDatabase().prepare(`UPDATE tenant_backups SET retention_state='expired' WHERE backup_id=? AND tenant_id=?`).run(row.backup_id, context.id) } catch {}
  }
}

export async function executeTenantBackup(user: User, requested?: string | null) {
  const context = tenant(user, requested), policy = rowPolicy(context.id)
  if (!policy.enabled) throw new Error('Tenant backup policy is disabled')
  const provider = resolveBackupProvider(policy.primary_provider)
  const backupId = `bkp_${randomUUID()}`, temp = mkdirTemp(`backup-${backupId}-`), exportResult = createTenantExport(user, context.tenantKey)
  const exportArchive = path.join(temp, `${backupId}.export.tar.gz`), metadataPath = path.join(temp, `${backupId}.metadata.json`), packagePath = path.join(temp, `${backupId}.package.tar.gz`), encryptedPath = path.join(temp, `${backupId}.mcbackup`)
  let inserted = false
  try {
    copyFile(exportResult.path, exportArchive)
    const exportManifest = JSON.parse(extractManifest(exportResult.path)) as any
    const metadata: BackupMetadata = { backup_id: backupId, tenant_id: context.id, tenant_key: context.tenantKey, export_schema_version: exportManifest.export_schema_version, application_commit: process.env.MISSION_CONTROL_COMMIT || 'unknown', created_at: new Date().toISOString(), encryption_format: BACKUP_FORMAT, encryption_profile_ref: policy.encryption_profile_ref, checksum_algorithm: 'sha256' }
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 }); packageExport(exportArchive, metadataPath, packagePath)
    const encrypted = encryptBackup(packagePath, encryptedPath, metadata, resolveBackupKey(policy.encryption_profile_ref))
    const objectId = `${backupId}.mcbackup`, record = { backup_id: backupId, tenant_id: context.id, provider: provider.name, object_id: objectId, export_schema_version: metadata.export_schema_version, application_commit: metadata.application_commit, encrypted_size: encrypted.size, encrypted_sha256: encrypted.sha256, encryption_format: metadata.encryption_format, encryption_profile_ref: metadata.encryption_profile_ref, upload_status: 'pending', remote_verification_status: 'pending', restore_verification_status: 'pending', retention_state: 'retained', audit_reference: `tenant_backup:${backupId}` }
    getDatabase().prepare(`INSERT INTO tenant_backups (backup_id,tenant_id,provider,object_id,export_schema_version,application_commit,encrypted_size,encrypted_sha256,encryption_format,encryption_profile_ref,upload_status,remote_verification_status,restore_verification_status,retention_state,audit_reference) VALUES (@backup_id,@tenant_id,@provider,@object_id,@export_schema_version,@application_commit,@encrypted_size,@encrypted_sha256,@encryption_format,@encryption_profile_ref,@upload_status,@remote_verification_status,@restore_verification_status,@retention_state,@audit_reference)`).run(record); inserted = true
    provider.upload(context.tenantKey, objectId, encryptedPath); provider.verify(context.tenantKey, objectId, encrypted.sha256, encrypted.size)
    getDatabase().prepare(`UPDATE tenant_backups SET upload_status='uploaded', remote_verification_status='verified' WHERE backup_id=? AND tenant_id=?`).run(backupId, context.id)
    const restore = verifyTenantBackup(user, backupId, context.tenantKey)
    updatePolicyStatus(context.id, { last_successful_backup: Math.floor(Date.now() / 1000), last_verified_backup: Math.floor(Date.now() / 1000), last_restore_test: Math.floor(Date.now() / 1000), status: 'healthy', failure_reason: null })
    retention(provider, context, policy)
    logAuditEvent({ action: 'tenant_backup_created', actor: user.username, actor_id: user.id, tenant_id: context.id, workspace_id: user.workspace_id, detail: { backup_id: backupId, provider: provider.name, object_id: objectId, sha256: encrypted.sha256, restore_verified: restore.files.length } })
    return { backup_id: backupId, provider: provider.name, object_id: objectId, encrypted_size: encrypted.size, encrypted_sha256: encrypted.sha256, restore_verification: restore, status: 'verified' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup failed'
    if (inserted) getDatabase().prepare(`UPDATE tenant_backups SET failure_reason=?, upload_status=CASE WHEN upload_status='pending' THEN 'failed' ELSE upload_status END WHERE backup_id=? AND tenant_id=?`).run(message.slice(0, 500), backupId, context.id)
    updatePolicyStatus(context.id, { status: 'failed', failure_reason: message.slice(0, 500) }); notifyFailure(context, user.workspace_id, 'Tenant backup failed', message); throw error
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

export function verifyTenantBackup(user: User, backupId: string, requested?: string | null) {
  const context = tenant(user, requested), row = getDatabase().prepare('SELECT * FROM tenant_backups WHERE backup_id=? AND tenant_id=?').get(backupId, context.id) as any
  if (!row) throw new Error('Backup not found for active tenant')
  const provider = resolveBackupProvider(row.provider), temp = mkdirTemp(`restore-${backupId}-`), encrypted = path.join(temp, `${backupId}.mcbackup`), packageDir = path.join(temp, 'package'), restored = path.join(temp, 'restored')
  try {
    provider.verify(context.tenantKey, row.object_id, row.encrypted_sha256, row.encrypted_size); provider.download(context.tenantKey, row.object_id, encrypted)
    if (sha256File(encrypted) !== row.encrypted_sha256) throw new Error('Encrypted backup checksum mismatch')
    const packagePath = path.join(temp, `${backupId}.package.tar.gz`), metadata = decryptBackup(encrypted, packagePath, resolveBackupKey(row.encryption_profile_ref))
    if (metadata.backup_id !== backupId || metadata.tenant_id !== context.id || metadata.tenant_key !== context.tenantKey) throw new Error('Backup metadata identity mismatch')
    const inspected = inspectAndExtractPackage(packagePath, packageDir), files = verifyExportArchive(inspected.exportArchive, restored, inspected.metadata)
    getDatabase().prepare(`UPDATE tenant_backups SET restore_verification_status='verified', failure_reason=NULL WHERE backup_id=? AND tenant_id=?`).run(backupId, context.id)
    return { status: 'verified', files }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Restore verification failed'; getDatabase().prepare(`UPDATE tenant_backups SET restore_verification_status='failed', failure_reason=? WHERE backup_id=? AND tenant_id=?`).run(message.slice(0, 500), backupId, context.id); notifyFailure(context, user.workspace_id, 'Tenant restore verification failed', message); throw error
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

function mkdirTemp(prefix: string): string { const dir = path.join(os.tmpdir(), 'mission-control-backup'); mkdirSync(dir, { recursive: true, mode: 0o700 }); const temp = path.join(dir, `${prefix}${randomUUID()}`); mkdirSync(temp, { recursive: true, mode: 0o700 }); return temp }
function copyFile(source: string, destination: string) { copyFileSync(source, destination); chmodSync(destination, 0o600) }
function extractManifest(archive: string): string { return execFileSync('tar', ['-xOzf', archive, '--wildcards', '*/manifest.json'], { encoding: 'utf8' }) }
