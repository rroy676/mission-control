import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { config } from './config'

export type ProviderCapabilities = {
  upload: boolean
  download: boolean
  list: boolean
  delete: boolean
  checksumVerification: boolean
  retention: boolean
  versioning: boolean
  resumableUpload: boolean
  serverSideEncryption: boolean
  objectLock: boolean
}

export type ProviderObject = { objectId: string; size: number; sha256?: string; modifiedAt: number }
export type BackupProvider = {
  name: string
  capabilities: ProviderCapabilities
  upload: (tenantKey: string, objectId: string, source: string) => ProviderObject
  download: (tenantKey: string, objectId: string, destination: string) => ProviderObject
  list: (tenantKey: string) => ProviderObject[]
  delete: (tenantKey: string, objectId: string) => void
  verify: (tenantKey: string, objectId: string, expectedSha256: string, expectedSize: number) => ProviderObject
}

export type RcloneProfile = { id: string; remoteName: string; basePrefix: string; enabled: boolean; role: 'primary' | 'secondary' }

const RCLONE_OBJECT = /^[a-zA-Z0-9_-]+\.mcbackup$/
const RCLONE_PART = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
function assertRclonePart(value: string, label: string) {
  if (!value || !RCLONE_PART.test(value) || value.startsWith('-') || value.includes(':') || value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid rclone ${label}`)
}
export function validateRcloneProfile(profile: RcloneProfile): RcloneProfile {
  assertRclonePart(profile.id, 'profile id'); assertRclonePart(profile.remoteName, 'remote name')
  if (!profile.basePrefix || profile.basePrefix.startsWith('/') || profile.basePrefix.includes(':') || profile.basePrefix.includes('..') || /[\u0000-\u001f\u007f]/.test(profile.basePrefix)) throw new Error('Invalid rclone base prefix')
  for (const part of profile.basePrefix.split('/')) if (part) assertRclonePart(part, 'base prefix')
  if (!profile.enabled) return profile
  const allowed = (process.env.MC_RCLONE_ALLOWED_REMOTES || '').split(',').map((v) => v.trim()).filter(Boolean)
  if (!allowed.includes(profile.remoteName)) throw new Error('Rclone remote is not operator-approved')
  return profile
}
function rcloneConfigArgs(): string[] { const configPath = process.env.MC_RCLONE_CONFIG; return configPath ? ['--config', configPath] : [] }
function remotePath(profile: RcloneProfile, tenantKey: string, objectId: string): string {
  if (!RCLONE_OBJECT.test(objectId)) throw new Error('Invalid backup object identifier')
  assertRclonePart(tenantKey, 'tenant namespace')
  return `${profile.remoteName}:${profile.basePrefix ? `${profile.basePrefix}/` : ''}${tenantKey}/${objectId}`
}
function rclone(profile: RcloneProfile, args: string[], output = 'utf8'): string {
  return execFileSync('rclone', [...rcloneConfigArgs(), ...args], { encoding: output as BufferEncoding, timeout: 120000, maxBuffer: 1024 * 1024 * 4 }) as unknown as string
}
export function createRcloneProvider(profile: RcloneProfile): BackupProvider {
  validateRcloneProfile(profile)
  return {
    name: `rclone:${profile.id}`,
    capabilities: { upload: true, download: true, list: true, delete: true, checksumVerification: true, retention: true, versioning: false, resumableUpload: false, serverSideEncryption: false, objectLock: false },
    upload(tenantKey, objectId, source) { const target = remotePath(profile, tenantKey, objectId); rclone(profile, ['copyto', source, target, '--retries', '2', '--low-level-retries', '2', '--no-traverse']); return { objectId, size: statSync(source).size, modifiedAt: Math.floor(Date.now() / 1000) } },
    download(tenantKey, objectId, destination) { const target = remotePath(profile, tenantKey, objectId); mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); rclone(profile, ['copyto', target, destination, '--retries', '2', '--low-level-retries', '2']); chmodSync(destination, 0o600); const s = statSync(destination); return { objectId, size: s.size, modifiedAt: Math.floor(s.mtimeMs / 1000) } },
    list(tenantKey) { const dir = `${profile.remoteName}:${profile.basePrefix ? `${profile.basePrefix}/` : ''}${tenantKey}`; const raw = rclone(profile, ['lsjson', dir, '--files-only', '--no-mimetype', '--no-modtime']); const items = JSON.parse(raw) as Array<{ Name: string; Size: number; ModTime?: string }>; return items.filter((i) => RCLONE_OBJECT.test(i.Name)).map((i) => ({ objectId: i.Name, size: i.Size, modifiedAt: i.ModTime ? Math.floor(Date.parse(i.ModTime) / 1000) : 0 })).sort((a, b) => b.modifiedAt - a.modifiedAt) },
    delete(tenantKey, objectId) { rclone(profile, ['deletefile', remotePath(profile, tenantKey, objectId), '--retries', '2']) },
    verify(tenantKey, objectId, expectedSha256, expectedSize) { const target = remotePath(profile, tenantKey, objectId); const raw = rclone(profile, ['size', target, '--json']); const info = JSON.parse(raw) as { bytes?: number }; if (info.bytes !== expectedSize) throw new Error('Remote backup size mismatch'); const listed = this.list(tenantKey).find((i) => i.objectId === objectId); if (!listed) throw new Error('Remote backup object missing'); const temp = path.join(os.tmpdir(), `mc-rclone-verify-${randomUUID()}`); try { rclone(profile, ['copyto', target, temp, '--retries', '2', '--low-level-retries', '2']); const actual = createHash('sha256').update(readFileSync(temp)).digest('hex'); if (actual !== expectedSha256) throw new Error('Remote backup checksum mismatch'); return { objectId, size: info.bytes, modifiedAt: listed.modifiedAt, sha256: actual } } finally { try { rmSync(temp, { force: true }) } catch {} } },
  }
}

function safePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid provider path component')
  return safe
}

function tenantRoot(tenantKey: string): string { return path.join(config.backupRoot, 'local-filesystem', safePart(tenantKey)) }
function objectPath(tenantKey: string, objectId: string): string {
  if (!/^[a-zA-Z0-9_-]+\.mcbackup$/.test(objectId)) throw new Error('Invalid backup object identifier')
  const root = tenantRoot(tenantKey), result = path.resolve(root, objectId)
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Backup object escaped provider root')
  return result
}

export const localFilesystemProvider: BackupProvider = {
  name: 'local-filesystem',
  capabilities: { upload: true, download: true, list: true, delete: true, checksumVerification: true, retention: true, versioning: false, resumableUpload: false, serverSideEncryption: false, objectLock: false },
  upload(tenantKey, objectId, source) {
    const destination = objectPath(tenantKey, objectId)
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(source, destination)
    chmodSync(destination, 0o600)
    const stat = statSync(destination)
    return { objectId, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs / 1000) }
  },
  download(tenantKey, objectId, destination) {
    const source = objectPath(tenantKey, objectId)
    if (!existsSync(source)) throw new Error('Backup object not found')
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(source, destination)
    chmodSync(destination, 0o600)
    const stat = statSync(destination)
    return { objectId, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs / 1000) }
  },
  list(tenantKey) {
    const root = tenantRoot(tenantKey)
    if (!existsSync(root)) return []
    return readdirSync(root).filter((name) => name.endsWith('.mcbackup')).map((objectId) => { const stat = statSync(objectPath(tenantKey, objectId)); return { objectId, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs / 1000) } }).sort((a, b) => b.modifiedAt - a.modifiedAt)
  },
  delete(tenantKey, objectId) { const target = objectPath(tenantKey, objectId); if (existsSync(target)) unlinkSync(target) },
  verify(tenantKey, objectId, expectedSha256, expectedSize) {
    const target = objectPath(tenantKey, objectId), stat = statSync(target), actualSha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
    if (stat.size !== expectedSize) throw new Error('Remote backup size mismatch')
    if (actualSha256 !== expectedSha256) throw new Error('Remote backup checksum mismatch')
    return { objectId, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs / 1000), sha256: actualSha256 }
  },
}

export function resolveBackupProvider(name: string): BackupProvider {
  if (name === localFilesystemProvider.name) return localFilesystemProvider
  if (name.startsWith('rclone:')) {
    const id = name.slice('rclone:'.length); assertRclonePart(id, 'profile id')
    const remoteName = process.env[`MC_RCLONE_PROFILE_${id}_REMOTE`]
    const basePrefix = process.env[`MC_RCLONE_PROFILE_${id}_PREFIX`] || ''
    if (!remoteName) throw new Error(`Backup provider is not configured: ${name}`)
    return createRcloneProvider({ id, remoteName, basePrefix, enabled: true, role: 'primary' })
  }
  throw new Error(`Backup provider is not configured: ${name}`)
}
