import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Database.Database | null, repo: '', archive: '', exports: '' }))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db, logAuditEvent: vi.fn() }))
vi.mock('@/lib/config', () => ({ config: { get durableRepoRoot() { return state.repo }, get durableArchiveRoot() { return state.archive }, get exportDir() { return state.exports }, get dataDir() { return path.dirname(state.exports) } } }))
vi.mock('@/lib/tenant-context', () => ({ requireTenantContext: (_user: unknown, requested?: string | null) => { const key = requested || 'tnt_alpha'; return { id: key === 'tnt_alpha' ? 1 : 2, tenantKey: key, slug: key.slice(4), displayName: key, status: 'active', membershipRole: 'owner', userId: 1 } } }))

import { promoteMemory } from '@/lib/durable-promotion'
import { createTenantExport, verifyExport } from '@/lib/tenant-export'

const user = { id: 1, username: 'owner', role: 'admin', tenant_id: 1, workspace_id: 11 } as any
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-promotion-export-')); state.repo = root; state.archive = path.join(root, 'Software-Studio'); state.exports = path.join(root, 'exports'); fs.mkdirSync(state.archive, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root }); execFileSync('git', ['config', 'user.name', 'Mission Control Test'], { cwd: root })
  state.db = new Database(':memory:'); state.db.exec(`
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, tenant_key TEXT, slug TEXT, display_name TEXT, status TEXT);
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER, name TEXT);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, workspace_id INTEGER, name TEXT);
    CREATE TABLE working_memory (id INTEGER PRIMARY KEY, memory_id TEXT, schema_version TEXT, tenant_id INTEGER, project_id INTEGER, agent_id INTEGER, task_id INTEGER, memory_type TEXT, scope TEXT, title TEXT, content TEXT, source TEXT, importance TEXT, lifecycle_status TEXT, promotion_status TEXT, durable_reference TEXT, metadata TEXT, source_references TEXT, created_at INTEGER, updated_at INTEGER, expires_at INTEGER, promotion_state TEXT, durable_id TEXT, durable_path TEXT, durable_commit_sha TEXT, promoted_at INTEGER, promoted_by TEXT, promotion_type TEXT);
    CREATE TABLE durable_promotions (id INTEGER PRIMARY KEY, tenant_id INTEGER, memory_id TEXT, durable_id TEXT, durable_path TEXT, promotion_type TEXT, state TEXT, source_hash TEXT, supersedes TEXT, actor TEXT, actor_id INTEGER, commit_sha TEXT, reason TEXT, created_at INTEGER);
    CREATE TABLE activities (id INTEGER, type TEXT, entity_type TEXT, entity_id INTEGER, actor TEXT, description TEXT, data TEXT, created_at INTEGER, tenant_id INTEGER, workspace_id INTEGER);
    CREATE TABLE audit_log (id INTEGER, action TEXT, actor TEXT, actor_id INTEGER, target_type TEXT, target_id INTEGER, detail TEXT, workspace_id INTEGER, tenant_id INTEGER);
    CREATE TABLE tenant_model_profiles (id INTEGER, tenant_id INTEGER, provider_id TEXT, model_id TEXT, purpose TEXT, scope TEXT, agent_id INTEGER, workflow_id INTEGER, task_id INTEGER, enabled INTEGER, priority INTEGER, credential_ref TEXT, fallback_profile_id INTEGER, promotional_free INTEGER, promotional_expires_at INTEGER, effective_from INTEGER, expires_at INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE tenant_model_usage (id INTEGER, tenant_id INTEGER, provider_id TEXT, model_id TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, estimated_cost REAL, actual_cost REAL, currency TEXT, occurred_at INTEGER);
  `); state.db.prepare('INSERT INTO tenants VALUES (1,?,?,?,?)').run('tnt_alpha','alpha','Alpha','active'); state.db.prepare('INSERT INTO tenants VALUES (2,?,?,?,?)').run('tnt_beta','beta','Beta','active'); state.db.prepare('INSERT INTO workspaces VALUES (11,1),(22,2)').run(); state.db.prepare('INSERT INTO projects VALUES (101,11,?)').run('Alpha project'); state.db.prepare('INSERT INTO agents VALUES (1001,11,?)').run('Alpha agent'); state.db.prepare('INSERT INTO working_memory (memory_id,schema_version,tenant_id,memory_type,scope,title,content,source,importance,lifecycle_status,promotion_status,durable_reference,metadata,source_references,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('mem_1234567890abcdef1234','1.0',1,'incident_context','tenant/company','Alpha incident','A durable incident summary','test','high','active','promotion-candidate',null,'{}','[]',1700000000,1700000000)
})
afterEach(() => { state.db?.close(); if (state.repo) fs.rmSync(state.repo, { recursive: true, force: true }) })

describe('durable promotion and portable export', () => {
  it('promotes only the effective tenant and is idempotent', () => {
    const first = promoteMemory(user, 'mem_1234567890abcdef1234', 'incident', 'tnt_alpha')
    const second = promoteMemory(user, 'mem_1234567890abcdef1234', 'incident', 'tnt_alpha')
    expect(first.durable_id).toBe(second.durable_id); expect(second.idempotent).toBe(true); expect(fs.existsSync(path.join(state.repo, first.durable_path))).toBe(true)
    expect(() => promoteMemory(user, 'mem_1234567890abcdef1234', 'incident', 'tnt_beta')).toThrow('Memory not found')
  })
  it('creates a structurally valid tenant-only archive with checksums', () => {
    const result = createTenantExport(user, 'tnt_alpha'); expect(result.status).toBe('completed'); const archive = path.join(state.exports, `${result.export_id}.tar.gz`); const validation = verifyExport(archive); expect(validation.valid).toBe(true); expect(validation.files).toContain('memory.jsonl'); expect(validation.files).not.toContain('checksums.txt')
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }); expect(listing).not.toContain('tnt_beta'); expect(listing).toContain('manifest.json')
  })
})
