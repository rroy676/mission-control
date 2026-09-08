#!/usr/bin/env node
import { createDecipheriv, createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const artifact = value('--artifact')
const keyFile = value('--key-file')
const destination = value('--destination') || path.join(os.tmpdir(), `mission-control-restore-${process.pid}`)
if (!artifact || !keyFile) fail('usage: verify-tenant-backup.mjs --artifact FILE --key-file FILE [--destination ISOLATED_DIR]')

const MAGIC = Buffer.from('MCBACKUP1\n')
const FORMAT = 'mc-backup-aes256gcm-1'
let keepDestination = Boolean(value('--destination'))
try {
  const keyText = readFileSync(keyFile, 'utf8').trim()
  const key = /^[0-9a-f]{64}$/i.test(keyText) ? Buffer.from(keyText, 'hex') : Buffer.from(keyText, 'base64')
  if (key.length !== 32) fail('recovery key must decode to 32 bytes')
  const encrypted = readFileSync(artifact)
  const encryptedSha256 = sha256(encrypted)
  if (encrypted.length < MAGIC.length + 4 + 12 + 16 || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) fail('invalid backup container')
  const headerLength = encrypted.readUInt32BE(MAGIC.length)
  if (headerLength <= 0 || headerLength > 32768) fail('invalid metadata length')
  const headerStart = MAGIC.length + 4
  const metadata = JSON.parse(encrypted.subarray(headerStart, headerStart + headerLength).toString('utf8'))
  if (metadata.encryption_format !== FORMAT || metadata.checksum_algorithm !== 'sha256') fail('unsupported backup format')
  const nonceStart = headerStart + headerLength
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(nonceStart, nonceStart + 12))
  decipher.setAAD(Buffer.concat([MAGIC, encrypted.subarray(headerStart, headerStart + headerLength)]))
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
  const packageBytes = Buffer.concat([decipher.update(encrypted.subarray(nonceStart + 12, encrypted.length - 16)), decipher.final()])
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const packagePath = path.join(destination, `${metadata.backup_id}.package.tar.gz`)
  writeFileSync(packagePath, packageBytes, { mode: 0o600 }); chmodSync(packagePath, 0o600)
  const packageListing = tarList(packagePath); assertSafe(packagePath, packageListing, false)
  const metadataName = packageListing.find((entry) => entry.endsWith('.metadata.json'))
  const exportName = packageListing.find((entry) => entry.endsWith('.export.tar.gz'))
  if (!metadataName || !exportName || packageListing.length !== 2) fail('package payload is incomplete')
  execFileSync('tar', ['-xzf', packagePath, '-C', destination, '--no-same-owner', '--no-same-permissions'])
  const packageMetadata = JSON.parse(readFileSync(path.join(destination, metadataName), 'utf8'))
  if (packageMetadata.backup_id !== metadata.backup_id || packageMetadata.tenant_id !== metadata.tenant_id || packageMetadata.tenant_key !== metadata.tenant_key) fail('backup identity mismatch')
  const exportArchive = path.join(destination, exportName)
  const exportListing = tarList(exportArchive); assertSafe(exportArchive, exportListing, true)
  const exportRoot = readdirSync(destination, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('tenant-export-'))
  const exportDir = path.join(destination, 'validated-export')
  mkdirSync(exportDir, { recursive: true, mode: 0o700 })
  execFileSync('tar', ['-xzf', exportArchive, '-C', exportDir, '--no-same-owner', '--no-same-permissions'])
  const roots = readdirSync(exportDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  if (roots.length !== 1 || !roots[0].name.startsWith('tenant-export-')) fail('invalid tenant export root')
  const root = path.join(exportDir, roots[0].name)
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.tenant_id !== metadata.tenant_id || manifest.tenant_key !== metadata.tenant_key || manifest.export_schema_version !== metadata.export_schema_version) fail('tenant or schema identity mismatch')
  const required = ['manifest.json', 'memory.jsonl', 'projects.json', 'agents.json', 'handoffs.jsonl', 'audit.jsonl', 'approvals.jsonl', 'configuration.json', 'cost-usage.jsonl', 'finance-metadata.json', 'checksums.txt']
  for (const file of required) if (!existsSync(path.join(root, file))) fail(`missing required file: ${file}`)
  const checksumLines = readFileSync(path.join(root, 'checksums.txt'), 'utf8').trim().split('\n').filter(Boolean)
  const checksumFiles = []
  for (const line of checksumLines) {
    const [expected, relative] = line.split(/\s{2}/)
    if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) fail('invalid checksum path')
    checksumFiles.push(relative)
    const target = path.resolve(root, relative)
    if (!target.startsWith(root + path.sep) || !existsSync(target) || sha256(readFileSync(target)) !== expected) fail(`checksum mismatch: ${relative}`)
  }
  const payloadFiles = files(root).filter((file) => file !== path.join(root, 'checksums.txt')).map((file) => path.relative(root, file).split(path.sep).join('/')).sort()
  if (JSON.stringify(payloadFiles) !== JSON.stringify([...checksumFiles].sort())) fail('checksum manifest does not cover the complete export')
  const secret = /-----BEGIN.*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|bearer\s+[A-Za-z0-9._-]{20,}/i
  for (const file of files(root)) if (secret.test(readFileSync(file, 'utf8'))) fail(`secret-like content found: ${path.relative(root, file)}`)
  console.log(JSON.stringify({ status: 'verified', backup_id: metadata.backup_id, tenant_id: metadata.tenant_id, tenant_key: metadata.tenant_key, encrypted_sha256: encryptedSha256, encrypted_size: encrypted.length, required_files: required.length }))
} catch (error) { fail(error instanceof Error ? error.message : 'restore verification failed') }
finally { if (!keepDestination) rmSync(destination, { recursive: true, force: true }) }

function sha256(data) { return createHash('sha256').update(data).digest('hex') }
function tarList(file) { return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean) }
function assertSafe(file, listing, allowDirectories) {
  const verbose = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean)
  if (verbose.some((entry) => /^[lh]/.test(entry))) fail('archive contains a link')
  for (const entry of listing) {
    const normalized = entry.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.split('/').includes('.') || entry.includes('\\')) fail('archive contains traversal')
    if (!allowDirectories && normalized.endsWith('/')) fail('package contains directories')
  }
}
function files(dir) { const result = []; for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isSymbolicLink()) fail('restored export contains symlink'); else if (entry.isDirectory()) result.push(...files(full)); else result.push(full) } return result }
function fail(message) { throw new Error(message) }
