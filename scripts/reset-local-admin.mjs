#!/usr/bin/env node
/** Explicit operator action; never called by build/start/deploy automatically. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
if (process.argv[2] !== '--from-env') { console.error('Usage: MC_ADMIN_PASSWORD=<new password> node scripts/reset-local-admin.mjs --from-env'); process.exit(2) }
const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
function dotenvValues() {
  const values = {}
  try { for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) { const trimmed = line.trim(); const i = trimmed.indexOf('='); if (i < 1 || trimmed.startsWith('#')) continue; const key = trimmed.slice(0, i).trim(); let value = trimmed.slice(i + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); else value = value.replace(/\s+#.*$/, '').trim(); values[key] = value } } catch {}
  return values
}
const env = dotenvValues()
let password = process.env.MC_ADMIN_PASSWORD
if (!password && env.AUTH_PASS_B64) password = Buffer.from(env.AUTH_PASS_B64, 'base64').toString('utf8')
if (!password) password = env.AUTH_PASS || ''
if (!password || password.length < 8) { console.error('MC_ADMIN_PASSWORD must be set and at least 8 characters; value is never printed'); process.exit(2) }
const dataDir = process.env.MISSION_CONTROL_DATA_DIR || path.join(root, '.data')
const dbPath = process.env.MISSION_CONTROL_DB_PATH || path.join(dataDir, 'mission-control.db')
if (!fs.existsSync(dbPath)) { console.error('Mission Control database is missing'); process.exit(1) }
const salt = crypto.randomBytes(16).toString('hex')
const hash = crypto.scryptSync(password, salt, 32, { N: 65536, maxmem: 134217728 }).toString('hex')
const db = new Database(dbPath)
try { const result = db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE username = 'hermes' AND role = 'admin' AND provider = 'local' AND is_approved = 1").run(`${salt}:${hash}`, Math.floor(Date.now() / 1000)); if (result.changes !== 1) { console.error('Expected exactly one approved local hermes admin'); process.exit(1) }; console.log(JSON.stringify({ status: 'UPDATED', username: 'hermes', credential_source: 'database', password: 'not_printed' })) } finally { db.close() }
