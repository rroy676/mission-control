#!/usr/bin/env node
/** Non-secret Mission Control authentication health check. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'

const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
const dataDir = process.env.MISSION_CONTROL_DATA_DIR || path.join(root, '.data')
const dbPath = process.env.MISSION_CONTROL_DB_PATH || path.join(dataDir, 'mission-control.db')
function envFile() {
  const result = {}
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      const i = trimmed.indexOf('=')
      if (i < 1 || trimmed.startsWith('#')) continue
      const key = trimmed.slice(0, i).trim()
      let value = trimmed.slice(i + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      else value = value.replace(/\s+#.*$/, '').trim()
      result[key] = value
    }
  } catch {}
  return result
}
function seedPassword(env) {
  if (env.AUTH_PASS_B64) {
    const normalized = env.AUTH_PASS_B64.trim()
    const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
    try {
      const decoded = Buffer.from(normalized, 'base64').toString('utf8')
      if (base64Pattern.test(normalized) && Buffer.from(decoded, 'utf8').toString('base64') === normalized && decoded) return decoded
    } catch {}
  }
  return env.AUTH_PASS || ''
}
function passwordMatches(password, stored) {
  try {
    const [salt, expected] = stored.split(':')
    if (!salt || !expected) return false
    const current = crypto.scryptSync(password, salt, 32, { N: 65536, maxmem: 134217728 }).toString('hex')
    if (current === expected) return true
    return crypto.scryptSync(password, salt, 32, { N: 16384 }).toString('hex') === expected
  } catch { return false }
}
if (!fs.existsSync(dbPath)) { console.log(JSON.stringify({ status: 'MISMATCH', reason: 'database_missing', db_path: dbPath })); process.exit(1) }
const db = new Database(dbPath, { readonly: true })
try {
  const rows = db.prepare("SELECT username, role, provider, is_approved, password_hash FROM users WHERE username = 'hermes'").all()
  const valid = rows.length === 1 && rows[0].role === 'admin' && rows[0].provider === 'local' && rows[0].is_approved === 1
  const env = envFile()
  const password = seedPassword(env)
  const credentialMatch = Boolean(password && rows[0] && passwordMatches(password, rows[0].password_hash))
  const result = { status: valid && credentialMatch ? 'MATCH' : 'MISMATCH', db_path: dbPath, hermes_admin_count: rows.length, account: rows[0] ? { username: rows[0].username, role: rows[0].role, provider: rows[0].provider, approved: rows[0].is_approved } : null, credential_source: 'database', configured_credential_check: credentialMatch ? 'MATCH' : 'MISMATCH' }
  console.log(JSON.stringify(result)); process.exit(valid && credentialMatch ? 0 : 1)
} finally { db.close() }
