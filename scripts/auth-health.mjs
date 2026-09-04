#!/usr/bin/env node
/** Non-secret Mission Control authentication health check. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'

const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
const dataDir = process.env.MISSION_CONTROL_DATA_DIR || path.join(root, '.data')
const dbPath = process.env.MISSION_CONTROL_DB_PATH || path.join(dataDir, 'mission-control.db')
const verifySeed = process.argv.includes('--verify-seed')
function envFile() {
  const result = {}
  try { for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) { const i = line.indexOf('='); if (i < 1 || line.trimStart().startsWith('#')) continue; let v = line.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); result[line.slice(0, i).trim()] = v } } catch {}
  return result
}
function seedPassword(env) {
  if (env.AUTH_PASS_B64) {
    try { return Buffer.from(env.AUTH_PASS_B64, 'base64').toString('utf8') } catch {}
  }
  return env.AUTH_PASS || ''
}
function passwordMatches(password, stored) { try { const [salt, expected] = stored.split(':'); return crypto.scryptSync(password, salt, 32, { N: 65536, maxmem: 134217728 }).toString('hex') === expected } catch { return false } }
if (!fs.existsSync(dbPath)) { console.log(JSON.stringify({ status: 'MISMATCH', reason: 'database_missing', db_path: dbPath })); process.exit(1) }
const db = new Database(dbPath, { readonly: true })
try {
  const rows = db.prepare("SELECT username, role, provider, is_approved, password_hash FROM users WHERE username = 'hermes'").all()
  const valid = rows.length === 1 && rows[0].role === 'admin' && rows[0].provider === 'local' && rows[0].is_approved === 1
  const result = { status: valid ? 'MATCH' : 'MISMATCH', db_path: dbPath, hermes_admin_count: rows.length, account: rows[0] ? { username: rows[0].username, role: rows[0].role, provider: rows[0].provider, approved: rows[0].is_approved } : null, credential_source: 'database' }
  if (verifySeed) { const env = envFile(); const password = seedPassword(env); result.seed_check = password && rows[0] ? (passwordMatches(password, rows[0].password_hash) ? 'MATCH' : 'MISMATCH') : 'MISMATCH' }
  console.log(JSON.stringify(result)); process.exit(valid ? 0 : 1)
} finally { db.close() }
