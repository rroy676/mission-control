#!/usr/bin/env node
/** Explicit operator action; never called by build/start/deploy automatically. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
if (process.argv[2] !== '--from-env') { console.error('Usage: MC_ADMIN_PASSWORD=<new password> node scripts/reset-local-admin.mjs --from-env'); process.exit(2) }
const root = path.resolve(new URL('.', import.meta.url).pathname, '..')
function dotenvValue(name) {
  try { const line = fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).find((item) => item.startsWith(`${name}=`)); if (!line) return ''; let value = line.slice(name.length + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); return value } catch { return '' }
}
let password = process.env.MC_ADMIN_PASSWORD || dotenvValue('AUTH_PASS')
if (!password && dotenvValue('AUTH_PASS_B64')) password = Buffer.from(dotenvValue('AUTH_PASS_B64'), 'base64').toString('utf8')
if (!password || password.length < 8) { console.error('MC_ADMIN_PASSWORD must be set and at least 8 characters; value is never printed'); process.exit(2) }
const dataDir = process.env.MISSION_CONTROL_DATA_DIR || path.join(root, '.data')
const dbPath = process.env.MISSION_CONTROL_DB_PATH || path.join(dataDir, 'mission-control.db')
if (!fs.existsSync(dbPath)) { console.error('Mission Control database is missing'); process.exit(1) }
const salt = crypto.randomBytes(16).toString('hex')
const hash = crypto.scryptSync(password, salt, 32, { N: 65536, maxmem: 134217728 }).toString('hex')
const db = new Database(dbPath)
try { const result = db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE username = 'hermes' AND role = 'admin' AND provider = 'local' AND is_approved = 1").run(`${salt}:${hash}`, Math.floor(Date.now() / 1000)); if (result.changes !== 1) { console.error('Expected exactly one approved local hermes admin'); process.exit(1) }; console.log(JSON.stringify({ status: 'UPDATED', username: 'hermes', credential_source: 'database', password: 'not_printed' })) } finally { db.close() }
