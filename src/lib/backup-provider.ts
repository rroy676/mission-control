import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
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
  throw new Error(`Backup provider is not configured: ${name}`)
}
