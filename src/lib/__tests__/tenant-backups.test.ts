import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const mocks = vi.hoisted(() => ({ db: null as Database.Database | null, root: '', providerRoot: '/tmp/mission-control-provider-test-root' }))
vi.mock('@/lib/db', () => ({ getDatabase: () => mocks.db, logAuditEvent: vi.fn() }))
vi.mock('@/lib/tenant-context', () => ({ requireTenantContext: (_user: unknown, requested?: string | null) => {
  const key = requested || 'tnt_alpha'
  if (key !== 'tnt_alpha') return { error: 'denied' }
  return { id: 1, tenantKey: key, workspaceId: 11, membershipRole: 'owner', userId: 1 }
} }))
vi.mock('@/lib/config', () => ({ config: { backupRoot: mocks.providerRoot, backupKeyFile: path.join(mocks.providerRoot, 'key') } }))
vi.mock('@/lib/tenant-export', () => ({ createTenantExport: vi.fn() }))

import { decryptBackup, deriveTestKey, encryptBackup, inspectAndExtractPackage, sha256File } from '@/lib/backup-format'
import { getTenantBackupPolicy, listTenantBackups } from '@/lib/tenant-backups'
import { localFilesystemProvider, createRcloneProvider } from '@/lib/backup-provider'

const user = { id: 1, username: 'tester', role: 'admin', workspace_id: 11, tenant_id: 1 } as any
let temp = ''

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-backup-test-')); mocks.root = temp
  mocks.db = new Database(':memory:')
  mocks.db.exec(`CREATE TABLE tenant_backup_policies (tenant_id INTEGER UNIQUE, enabled INTEGER, local_snapshot_policy TEXT, primary_provider TEXT, secondary_provider TEXT, retention_count INTEGER, retention_period TEXT, encryption_profile_ref TEXT, export_schedule TEXT, backup_schedule TEXT, integrity_check_schedule TEXT, restore_test_schedule TEXT, last_successful_backup INTEGER, last_verified_backup INTEGER, last_restore_test INTEGER, status TEXT, failure_reason TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0); CREATE TABLE tenant_backups (backup_id TEXT, tenant_id INTEGER, created_at INTEGER DEFAULT 0);`)
})
afterEach(() => { mocks.db?.close(); fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(mocks.providerRoot, { recursive: true, force: true }) })

describe('encrypted backup primitives', () => {
  it('authenticates the container and rejects a wrong key', () => {
    const input = path.join(temp, 'plain'), encrypted = path.join(temp, 'backup.mcbackup'), output = path.join(temp, 'out')
    fs.writeFileSync(input, 'portable payload')
    const metadata: any = { backup_id: 'bkp_test', tenant_id: 1, tenant_key: 'tnt_alpha', export_schema_version: 'tenant-export-1.0', application_commit: 'test', created_at: new Date().toISOString(), encryption_format: 'mc-backup-aes256gcm-1', encryption_profile_ref: 'test', checksum_algorithm: 'sha256' }
    const key = deriveTestKey('ephemeral-test-key'); encryptBackup(input, encrypted, metadata, key)
    expect(sha256File(encrypted)).toHaveLength(64)
    expect(decryptBackup(encrypted, output, key).backup_id).toBe('bkp_test')
    expect(fs.readFileSync(output, 'utf8')).toBe('portable payload')
    expect(() => decryptBackup(encrypted, path.join(temp, 'wrong'), deriveTestKey('wrong'))).toThrow()
    const tampered = fs.readFileSync(encrypted); tampered[tampered.length - 20] ^= 1; fs.writeFileSync(encrypted, tampered)
    expect(() => decryptBackup(encrypted, path.join(temp, 'tampered'), key)).toThrow()
  })

  it('keeps local provider objects tenant-scoped and rejects forged object paths', () => {
    const source = path.join(temp, 'source'), destination = path.join(temp, 'destination'); fs.writeFileSync(source, 'ciphertext')
    localFilesystemProvider.upload('tnt_alpha', 'bkp_one.mcbackup', source)
    expect(localFilesystemProvider.list('tnt_alpha')).toHaveLength(1)
    expect(localFilesystemProvider.list('tnt_beta')).toHaveLength(0)
    expect(() => localFilesystemProvider.download('tnt_beta', 'bkp_one.mcbackup', destination)).toThrow()
    expect(() => localFilesystemProvider.upload('tnt_alpha', '../escape.mcbackup', source)).toThrow()
  })

  it('exercises the bounded rclone adapter against an isolated local backend', () => {
    const source = path.join(temp, 'source.mcbackup'), destination = path.join(temp, 'download.mcbackup'), remote = `tmp-rclone-test-${Date.now()}`, rcloneConfig = path.join(temp, 'rclone.conf')
    fs.mkdirSync(remote); fs.writeFileSync(source, 'isolated encrypted artifact')
    fs.writeFileSync(rcloneConfig, '[isolated]\ntype = local\n')
    const old = { config: process.env.MC_RCLONE_CONFIG, allowed: process.env.MC_RCLONE_ALLOWED_REMOTES }
    process.env.MC_RCLONE_CONFIG = rcloneConfig; process.env.MC_RCLONE_ALLOWED_REMOTES = 'isolated'
    try {
      const provider = createRcloneProvider({ id: 'test', remoteName: 'isolated', basePrefix: remote, enabled: true, role: 'primary' })
      provider.upload('tnt_alpha', 'bkp_one.mcbackup', source)
      expect(provider.list('tnt_alpha')).toHaveLength(1)
      expect(provider.verify('tnt_alpha', 'bkp_one.mcbackup', sha256File(source), fs.statSync(source).size).sha256).toBe(sha256File(source))
      provider.download('tnt_alpha', 'bkp_one.mcbackup', destination); expect(fs.readFileSync(destination, 'utf8')).toBe('isolated encrypted artifact')
      expect(() => provider.download('tnt_beta', 'bkp_one.mcbackup', path.join(temp, 'foreign'))).toThrow()
      expect(() => createRcloneProvider({ id: 'bad', remoteName: 'isolated', basePrefix: '../escape', enabled: true, role: 'primary' })).toThrow()
    } finally { if (old.config === undefined) delete process.env.MC_RCLONE_CONFIG; else process.env.MC_RCLONE_CONFIG = old.config; if (old.allowed === undefined) delete process.env.MC_RCLONE_ALLOWED_REMOTES; else process.env.MC_RCLONE_ALLOWED_REMOTES = old.allowed; fs.rmSync(remote, { recursive: true, force: true }) }
  }, 15_000)

  it('rejects package symlinks before extraction', () => {
    const source = path.join(temp, 'package-source'), archive = path.join(temp, 'unsafe.tar.gz'), destination = path.join(temp, 'extract')
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'safe.metadata.json'), '{}'); fs.symlinkSync('/etc/passwd', path.join(source, 'escape.export.tar.gz'))
    execFileSync('tar', ['-czf', archive, '-C', source, 'safe.metadata.json', '-C', source, 'escape.export.tar.gz'])
    expect(() => inspectAndExtractPackage(archive, destination)).toThrow(/link/i)
    expect(fs.existsSync(path.join(destination, 'escape.export.tar.gz'))).toBe(false)
  })
})

describe('tenant backup policy isolation', () => {
  it('does not expose another tenant policy or backup rows', () => {
    const alpha = getTenantBackupPolicy(user, 'tnt_alpha') as any
    expect(alpha.tenant_id).toBe(1)
    mocks.db!.prepare("INSERT INTO tenant_backups (backup_id, tenant_id) VALUES ('alpha', 1), ('beta', 2)").run()
    expect(listTenantBackups(user, 'tnt_alpha').map((row: any) => row.backup_id)).toEqual(['alpha'])
    expect(() => getTenantBackupPolicy(user, 'not-authorized')).toThrow()
    expect(() => listTenantBackups(user, 'tnt_beta')).toThrow()
  })
})
