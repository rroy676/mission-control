import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { resolveEffectiveModel, saveProfile, createCredentialReference, type ModelProfile } from '@/lib/model-profiles'
import type { TenantContext } from '@/lib/tenant-context'

let db: Database.Database
const alpha: TenantContext = { id: 1, tenantKey: 'tnt_alpha', slug: 'alpha', displayName: 'Alpha', status: 'active', membershipRole: 'owner', userId: 1 }
const beta: TenantContext = { id: 2, tenantKey: 'tnt_beta', slug: 'beta', displayName: 'Beta', status: 'active', membershipRole: 'owner', userId: 2 }

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE model_provider_catalog (id INTEGER PRIMARY KEY, provider_id TEXT, model_id TEXT, display_name TEXT, enabled_globally INTEGER DEFAULT 1, context_window INTEGER, capabilities TEXT DEFAULT '{}', pricing_metadata TEXT DEFAULT '{}', promotional_free INTEGER DEFAULT 0, promotional_expires_at INTEGER, deprecated INTEGER DEFAULT 0);
    CREATE TABLE tenant_credentials (tenant_id INTEGER, credential_ref TEXT, provider_id TEXT, status TEXT DEFAULT 'unconfigured', updated_at INTEGER, UNIQUE(tenant_id, credential_ref));
    CREATE TABLE tenant_model_profiles (id INTEGER PRIMARY KEY, tenant_id INTEGER, provider_id TEXT, model_id TEXT, purpose TEXT, scope TEXT, agent_id INTEGER, workflow_id INTEGER, task_id INTEGER, enabled INTEGER, priority INTEGER, credential_ref TEXT, fallback_profile_id INTEGER, promotional_free INTEGER, promotional_expires_at INTEGER, effective_from INTEGER, expires_at INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, workspace_id INTEGER);
  `)
  db.prepare("INSERT INTO model_provider_catalog (provider_id,model_id,display_name) VALUES ('openrouter','openai/gpt-4.1-mini','OpenRouter Mini')").run()
  db.prepare("INSERT INTO model_provider_catalog (provider_id,model_id,display_name) VALUES ('anthropic','claude-sonnet-4-6','Sonnet')").run()
  db.prepare("INSERT INTO tenant_credentials (tenant_id,credential_ref,provider_id) VALUES (1,'alpha/openrouter/primary','openrouter'),(2,'beta/openrouter/primary','openrouter')").run()
  db.prepare('INSERT INTO workspaces (id,tenant_id) VALUES (11,1),(22,2)').run()
  db.prepare('INSERT INTO agents (id,workspace_id) VALUES (101,11),(202,22)').run()
})

afterEach(() => db.close())

function profile(tenantId: number, id: number, model: string, scope = 'tenant-default', agentId: number | null = null, fallback: number | null = null): void {
  db.prepare(`INSERT INTO tenant_model_profiles (id,tenant_id,provider_id,model_id,purpose,scope,agent_id,enabled,priority,credential_ref,fallback_profile_id,promotional_free,effective_from,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch(),unixepoch())`).run(id, tenantId, model.split('/')[0], model.split('/').slice(1).join('/'), 'general', scope, agentId, 1, 10, null, fallback, 0)
}

describe('tenant model profile isolation and resolution', () => {
  it('keeps defaults and effective results tenant-local', () => {
    profile(1, 1, 'openrouter/openai/gpt-4.1-mini')
    profile(2, 2, 'anthropic/claude-sonnet-4-6')
    expect(resolveEffectiveModel(alpha, {}, db)?.profile_id).toBe(1)
    expect(resolveEffectiveModel(beta, {}, db)?.profile_id).toBe(2)
    expect(resolveEffectiveModel(alpha, {}, db)?.provider_id).toBe('openrouter')
    expect(resolveEffectiveModel(beta, {}, db)?.provider_id).toBe('anthropic')
  })

  it('does not follow a fallback row from another tenant', () => {
    profile(2, 2, 'anthropic/claude-sonnet-4-6')
    profile(1, 1, 'openrouter/openai/gpt-4.1-mini', 'tenant-default', null, 2)
    const effective = resolveEffectiveModel(alpha, {}, db)
    expect(effective?.profile_id).toBe(1)
    expect(effective?.fallback_chain).not.toContain(2)
  })

  it('rejects cross-tenant credentials and agent targets', () => {
    expect(() => saveProfile(alpha, { provider_id: 'openrouter', model_id: 'openai/gpt-4.1-mini', credential_ref: 'beta/openrouter/primary' }, db)).toThrow(/Credential reference/)
    expect(() => saveProfile(alpha, { provider_id: 'openrouter', model_id: 'openai/gpt-4.1-mini', scope: 'agent-override', agent_id: 202 }, db)).toThrow(/Agent does not belong/)
    createCredentialReference(alpha, 'openrouter', 'alpha/openrouter/secondary', db)
    const created = saveProfile(alpha, { provider_id: 'openrouter', model_id: 'openai/gpt-4.1-mini', credential_ref: 'alpha/openrouter/secondary' }, db)
    expect((created as ModelProfile).tenant_id).toBe(1)
  })
})
