import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config } from './config'

export const BACKUP_FORMAT = 'mc-backup-aes256gcm-1'
const MAGIC = Buffer.from('MCBACKUP1\n')
const HEADER_LIMIT = 32 * 1024

export type BackupMetadata = {
  backup_id: string
  tenant_id: number
  tenant_key: string
  export_schema_version: string
  application_commit: string
  created_at: string
  encryption_format: typeof BACKUP_FORMAT
  encryption_profile_ref: string
  checksum_algorithm: 'sha256'
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function resolveBackupKey(profileRef: string, keyFile = config.backupKeyFile): Buffer {
  const envName = `MC_BACKUP_KEY_${profileRef.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
  const raw = process.env[envName] || (profileRef === 'local-default' ? process.env.MC_BACKUP_KEY : '')
  const value = raw || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '')
  if (!value) throw new Error(`Backup key reference is unavailable: ${profileRef}`)
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('Backup key must decode to exactly 32 bytes')
  return key
}

export function encryptBackup(input: string, output: string, metadata: BackupMetadata, key: Buffer): { size: number; sha256: string } {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key')
  const header = Buffer.from(JSON.stringify(metadata), 'utf8')
  if (header.length > HEADER_LIMIT) throw new Error('Backup metadata is too large')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.concat([MAGIC, header]))
  const ciphertext = Buffer.concat([cipher.update(readFileSync(input)), cipher.final()])
  const tag = cipher.getAuthTag()
  const result = Buffer.concat([MAGIC, Buffer.alloc(4), header, nonce, ciphertext, tag])
  result.writeUInt32BE(header.length, MAGIC.length)
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
  writeFileSync(output, result, { mode: 0o600 })
  chmodSync(output, 0o600)
  return { size: result.length, sha256: createHash('sha256').update(result).digest('hex') }
}

export function decryptBackup(input: string, output: string, key: Buffer): BackupMetadata {
  const data = readFileSync(input)
  if (data.length < MAGIC.length + 4 + 12 + 16 || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid backup container header')
  const headerLength = data.readUInt32BE(MAGIC.length)
  if (headerLength <= 0 || headerLength > HEADER_LIMIT) throw new Error('Invalid backup metadata length')
  const headerStart = MAGIC.length + 4
  const header = JSON.parse(data.subarray(headerStart, headerStart + headerLength).toString('utf8')) as BackupMetadata
  if (header.encryption_format !== BACKUP_FORMAT || header.checksum_algorithm !== 'sha256') throw new Error('Unsupported backup encryption format')
  const nonceStart = headerStart + headerLength
  const nonce = data.subarray(nonceStart, nonceStart + 12)
  const tag = data.subarray(data.length - 16)
  const ciphertext = data.subarray(nonceStart + 12, data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.concat([MAGIC, data.subarray(headerStart, headerStart + headerLength)]))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
  writeFileSync(output, plaintext, { mode: 0o600 })
  return header
}

export function packageExport(exportArchive: string, metadataPath: string, output: string): void {
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
  execFileSync('tar', ['-czf', output, '-C', path.dirname(exportArchive), path.basename(exportArchive), '-C', path.dirname(metadataPath), path.basename(metadataPath)], { stdio: ['ignore', 'ignore', 'pipe'] })
  chmodSync(output, 0o600)
}

export function inspectAndExtractPackage(packagePath: string, destination: string): { metadata: BackupMetadata; exportArchive: string } {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const listing = execFileSync('tar', ['-tzf', packagePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)
  assertSafeTarListing(packagePath, listing, false)
  if (listing.some((entry) => entry.endsWith('/'))) throw new Error('Backup package may not contain directories')
  const metadataName = listing.find((entry) => entry.endsWith('.metadata.json'))
  const exportName = listing.find((entry) => entry.endsWith('.export.tar.gz'))
  if (!metadataName || !exportName || listing.length !== 2) throw new Error('Backup package is missing required payload files')
  execFileSync('tar', ['-xzf', packagePath, '-C', destination, '--no-same-owner', '--no-same-permissions'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const metadata = JSON.parse(readFileSync(path.join(destination, metadataName), 'utf8')) as BackupMetadata
  if (metadata.backup_id !== path.basename(exportName).replace('.export.tar.gz', '')) throw new Error('Backup metadata/package identity mismatch')
  return { metadata, exportArchive: path.join(destination, exportName) }
}

export function verifyExportArchive(exportArchive: string, destination: string, expected: BackupMetadata): string[] {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const listing = execFileSync('tar', ['-tzf', exportArchive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)
  assertSafeTarListing(exportArchive, listing, true)
  execFileSync('tar', ['-xzf', exportArchive, '-C', destination, '--no-same-owner', '--no-same-permissions'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const roots = readdirDirectories(destination)
  if (roots.length !== 1 || !/^tenant-export-/.test(roots[0])) throw new Error('Tenant export root is invalid')
  const root = path.join(destination, roots[0])
  const manifestPath = path.join(root, 'manifest.json')
  const checksumsPath = path.join(root, 'checksums.txt')
  if (!existsSync(manifestPath) || !existsSync(checksumsPath)) throw new Error('Tenant export manifest/checksums missing')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
  if (manifest.tenant_id !== expected.tenant_id || manifest.tenant_key !== expected.tenant_key) throw new Error('Restored tenant identity mismatch')
  if (manifest.export_schema_version !== expected.export_schema_version || manifest.checksum_algorithm !== 'sha256') throw new Error('Tenant export schema mismatch')
  const required = ['manifest.json', 'memory.jsonl', 'projects.json', 'agents.json', 'handoffs.jsonl', 'audit.jsonl', 'approvals.jsonl', 'configuration.json', 'cost-usage.jsonl', 'finance-metadata.json', 'checksums.txt']
  for (const file of required) if (!existsSync(path.join(root, file))) throw new Error(`Tenant export missing ${file}`)
  const checksumFiles: string[] = []
  for (const line of readFileSync(checksumsPath, 'utf8').trim().split('\n').filter(Boolean)) {
    const [expectedHash, relative] = line.split(/\s{2}/)
    if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Invalid checksum path')
    checksumFiles.push(relative)
    const target = path.resolve(root, relative)
    if (!target.startsWith(root + path.sep) || !existsSync(target) || createHash('sha256').update(readFileSync(target)).digest('hex') !== expectedHash) throw new Error(`Checksum mismatch: ${relative}`)
  }
  const payloadFiles = walkFiles(root).filter((file) => file !== checksumsPath).map((file) => path.relative(root, file).split(path.sep).join('/')).sort()
  if (JSON.stringify(payloadFiles) !== JSON.stringify([...checksumFiles].sort())) throw new Error('Checksum manifest does not cover the complete export')
  const secret = /-----BEGIN.*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|bearer\s+[A-Za-z0-9._-]{20,}/i
  for (const file of walkFiles(root)) if (file !== checksumsPath && secret.test(readFileSync(file, 'utf8'))) throw new Error(`Secret-like content found in ${path.relative(root, file)}`)
  return required
}

function assertSafeTarListing(archive: string, listing: string[], allowDirectories: boolean): void {
  const verbose = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean)
  if (verbose.some((entry) => /^[lh]/.test(entry))) throw new Error('Archive contains a symlink or hard link')
  for (const entry of listing) {
    const normalized = entry.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.split('/').includes('.') || entry.includes('\\')) throw new Error('Archive contains a traversal path')
    if (!allowDirectories && normalized.endsWith('/')) throw new Error('Backup package may not contain directories')
  }
}

function readdirDirectories(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) }
function walkFiles(dir: string): string[] { const result: string[] = []; for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) result.push(...walkFiles(full)); else if (entry.isSymbolicLink()) throw new Error('Restored export contains a symlink'); else result.push(full) } return result }

export function deriveTestKey(seed: string): Buffer { return scryptSync(seed, 'mission-control-backup-test', 32) }
