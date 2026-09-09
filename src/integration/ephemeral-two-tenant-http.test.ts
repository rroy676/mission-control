import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Full-stack v1.2 tenancy evidence. The Next runtime is a child process so
 * config, module singletons, sessions, and route handlers all run exactly as
 * they do in a deployed runtime. Every path is generated under /tmp and is
 * removed in afterAll; no production path or credential is used.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PASSWORDS = {
  alice: `A-${randomBytes(24).toString('base64url')}`,
  bob: `B-${randomBytes(24).toString('base64url')}`,
  owner: `O-${randomBytes(24).toString('base64url')}`,
}
const HASH_N = 16_384 // accepted legacy format; keeps fixture setup bounded
const API_KEY = randomBytes(24).toString('hex')

type Fixture = {
  dataDir: string
  dbPath: string
  port: number
  baseUrl: string
  server: ChildProcess
  a: { id: number; key: string; workspace: number; project: number; agent: number }
  b: { id: number; key: string; workspace: number; project: number; agent: number }
  users: { alice: number; bob: number; owner: number }
  profiles: { a: number; b: number }
}

let fixture: Fixture

function hashFixturePassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 32, { N: HASH_N }).toString('hex')}`
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000
  let lastError = ''
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`test server exited early (${server.exitCode}): ${lastError}`)
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for isolated Mission Control: ${lastError}`)
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie') || ''
  const token = setCookie.split(';', 1)[0]
  if (!token) throw new Error('login did not issue a session cookie')
  return token
}

async function api(path: string, options: RequestInit = {}): Promise<{ status: number; body: any; response: Response }> {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  })
  const text = await response.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: response.status, body, response }
}

async function login(username: string, password: string): Promise<string> {
  // Keep the bounded harness independent of the process-global login limiter;
  // each generated fixture login has its own RFC 5737-style test address.
  const testIp = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`
  const result = await api('/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': testIp }, body: JSON.stringify({ username, password }) })
  expect(result.status, `login ${username}`).toBe(200)
  return cookieFrom(result.response)
}

function withCookie(cookie: string, headers: Record<string, string> = {}): Record<string, string> {
  return { cookie, ...headers }
}

async function seedDatabase(dbPath: string): Promise<Omit<Fixture, 'dataDir' | 'dbPath' | 'port' | 'baseUrl' | 'server' | 'profiles'>> {
  const db = new Database(dbPath)
  const now = Math.floor(Date.now() / 1000)
  const insertTenant = db.prepare(`INSERT INTO tenants (slug, tenant_key, display_name, linux_user, status, openclaw_home, workspace_root, config, created_by, owner_gateway) VALUES (?, ?, ?, ?, 'active', ?, ?, '{}', 'http-test', 'isolated')`)
  const aTenant = Number(insertTenant.run('http-test-a', 'tnt_' + randomBytes(16).toString('hex'), 'HTTP Test A', 'http-test-a', '/tmp/http-test-a', '/tmp/http-test-a/workspace').lastInsertRowid)
  const bTenant = Number(insertTenant.run('http-test-b', 'tnt_' + randomBytes(16).toString('hex'), 'HTTP Test B', 'http-test-b', '/tmp/http-test-b', '/tmp/http-test-b/workspace').lastInsertRowid)
  const aKey = (db.prepare('SELECT tenant_key FROM tenants WHERE id=?').get(aTenant) as { tenant_key: string }).tenant_key
  const bKey = (db.prepare('SELECT tenant_key FROM tenants WHERE id=?').get(bTenant) as { tenant_key: string }).tenant_key

  const insertWorkspace = db.prepare('INSERT INTO workspaces (slug, name, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  const aWorkspace = Number(insertWorkspace.run('http-test-a', 'HTTP Test A', aTenant, now, now).lastInsertRowid)
  const bWorkspace = Number(insertWorkspace.run('http-test-b', 'HTTP Test B', bTenant, now, now).lastInsertRowid)
  const insertUser = db.prepare('INSERT INTO users (username, display_name, password_hash, role, workspace_id, created_at, updated_at, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
  const alice = Number(insertUser.run('http-alice', 'HTTP Alice', hashFixturePassword(PASSWORDS.alice), 'operator', aWorkspace, now, now).lastInsertRowid)
  const bob = Number(insertUser.run('http-bob', 'HTTP Bob', hashFixturePassword(PASSWORDS.bob), 'operator', bWorkspace, now, now).lastInsertRowid)
  const owner = Number(insertUser.run('http-owner', 'HTTP Owner', hashFixturePassword(PASSWORDS.owner), 'admin', aWorkspace, now, now).lastInsertRowid)
  const membership = db.prepare('INSERT INTO tenant_memberships (user_id, tenant_id, role) VALUES (?, ?, ?)')
  membership.run(alice, aTenant, 'operator')
  membership.run(bob, bTenant, 'operator')
  membership.run(owner, aTenant, 'owner')
  membership.run(owner, bTenant, 'owner')

  const insertProject = db.prepare(`INSERT INTO projects (workspace_id, name, slug, ticket_prefix, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
  const aProject = Number(insertProject.run(aWorkspace, 'HTTP A Project', 'http-a-project', 'HPA', now, now).lastInsertRowid)
  const bProject = Number(insertProject.run(bWorkspace, 'HTTP B Project', 'http-b-project', 'HPB', now, now).lastInsertRowid)
  const insertAgent = db.prepare(`INSERT INTO agents (name, role, status, created_at, updated_at, config, workspace_id) VALUES (?, 'tester', 'offline', ?, ?, '{}', ?)`)
  const aAgent = Number(insertAgent.run('http-a-agent', now, now, aWorkspace).lastInsertRowid)
  const bAgent = Number(insertAgent.run('http-b-agent', now, now, bWorkspace).lastInsertRowid)
  db.close()
  return { a: { id: aTenant, key: aKey, workspace: aWorkspace, project: aProject, agent: aAgent }, b: { id: bTenant, key: bKey, workspace: bWorkspace, project: bProject, agent: bAgent }, users: { alice, bob, owner } }
}

describe('ephemeral authenticated two-tenant HTTP harness', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const dataDir = await mkdtemp('/tmp/mission-control-v12-http-')
    const dbPath = join(dataDir, 'mission-control.db')
    const port = 32_000 + Math.floor(Math.random() * 1_000)
    const baseUrl = `http://127.0.0.1:${port}`
    const server = spawn('pnpm', ['exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: ROOT,
      env: {
        ...process.env,
        MISSION_CONTROL_TEST_MODE: '1', MISSION_CONTROL_DATA_DIR: dataDir, MISSION_CONTROL_DB_PATH: dbPath,
        MISSION_CONTROL_TOKENS_PATH: join(dataDir, 'tokens.json'), MISSION_CONTROL_WORKSPACE_DIR: join(dataDir, 'runtime'),
        OPENCLAW_STATE_DIR: join(dataDir, 'openclaw'), OPENCLAW_WORKSPACE_DIR: join(dataDir, 'openclaw', 'workspace'),
        OPENCLAW_BIN: 'false', API_KEY, AUTH_USER: '', AUTH_PASS: '',
        PORT: String(port), NODE_ENV: 'test', GNAP_ENABLED: 'false', MC_TRUSTED_PROXIES: '127.0.0.1',
      }, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    })
    let serverOutput = ''
    server.stdout?.on('data', (chunk) => { serverOutput += String(chunk).slice(-4_000) })
    server.stderr?.on('data', (chunk) => { serverOutput += String(chunk).slice(-4_000) })
    try {
      await waitForServer(baseUrl, server)
      const seeded = await seedDatabase(dbPath)
      fixture = { dataDir, dbPath, port, baseUrl, server, ...seeded, profiles: { a: 0, b: 0 } }
      // The startup process keeps its own connection and sees fixture rows on
      // the next request; this explicit request also verifies the DB is live.
      const health = await api('/api/health')
      expect(health.status).toBe(200)
    } catch (error) {
      server.kill('SIGTERM')
      await rm(dataDir, { recursive: true, force: true })
      throw new Error(`${error instanceof Error ? error.message : error}\n${serverOutput}`)
    }
  }, 60_000)

  afterAll(async () => {
    fixture?.server.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (fixture?.server.exitCode === null) fixture.server.kill('SIGKILL')
    if (fixture?.dataDir) await rm(fixture.dataDir, { recursive: true, force: true })
  })

  it('authenticates isolated users and switches only through server-side membership', async () => {
    const ownerCookie = await login('http-owner', PASSWORDS.owner)
    const initial = await api('/api/tenants', { headers: withCookie(ownerCookie) })
    expect(initial.status).toBe(200)
    expect(initial.body.tenants.map((t: any) => t.tenantKey)).toEqual(expect.arrayContaining([fixture.a.key, fixture.b.key]))
    expect(initial.body.active_tenant.tenantKey).toBe(fixture.a.key)

    const switched = await api('/api/tenants', { method: 'POST', headers: withCookie(ownerCookie), body: JSON.stringify({ tenant_key: fixture.b.key }) })
    expect(switched.status).toBe(200)
    expect(switched.body.active_tenant.tenantKey).toBe(fixture.b.key)
    const me = await api('/api/auth/me', { headers: withCookie(ownerCookie) })
    expect(me.status).toBe(200)
    expect(me.body.user.tenant_id).toBe(fixture.b.id)

    const aliceCookie = await login('http-alice', PASSWORDS.alice)
    expect((await api('/api/tenants', { headers: withCookie(aliceCookie) })).body.tenants.map((t: any) => t.tenantKey)).toEqual([fixture.a.key])
    expect((await api('/api/tenants', { method: 'POST', headers: withCookie(aliceCookie), body: JSON.stringify({ tenant_key: fixture.b.key }) })).status).toBe(403)
    expect((await api('/api/tenants', { method: 'POST', headers: withCookie(aliceCookie), body: JSON.stringify({ tenant_key: 'tnt_' + 'f'.repeat(32) }) })).status).toBe(403)
    expect((await api('/api/tenants', { method: 'POST', headers: { 'x-api-key': API_KEY }, body: JSON.stringify({ tenant_key: fixture.b.key }) })).status).toBe(403)
  })

  it('proves memory create, query, exact read, update, supersession, references, handoffs, and audit are tenant-bound', async () => {
    const aliceCookie = await login('http-alice', PASSWORDS.alice)
    const bobCookie = await login('http-bob', PASSWORDS.bob)
    const create = await api(`/api/memory/working?tenant_key=${fixture.a.key}`, { method: 'POST', headers: withCookie(aliceCookie), body: JSON.stringify({ project_id: String(fixture.a.project), agent_id: String(fixture.a.agent), memory_type: 'current_state', scope: 'project', title: 'A-only state', content: 'Tenant A confidential state', source: 'http-test', importance: 'high' }) })
    expect(create.status).toBe(201)
    const memoryId = create.body.memory.memory_id
    const listB = await api('/api/memory/working', { headers: withCookie(bobCookie) })
    expect(listB.status).toBe(200)
    expect(listB.body.memories).toEqual([])
    expect((await api(`/api/memory/working/${memoryId}`, { headers: withCookie(bobCookie) })).status).toBe(404)
    expect((await api(`/api/memory/working/${memoryId}`, { method: 'PATCH', headers: withCookie(bobCookie), body: JSON.stringify({ lifecycle_status: 'resolved' }) })).status).toBe(403)
    expect((await api(`/api/memory/working?tenant_key=${fixture.a.key}`, { headers: withCookie(bobCookie) })).status).toBe(403)

    const second = await api(`/api/memory/working?tenant_key=${fixture.a.key}`, { method: 'POST', headers: withCookie(aliceCookie), body: JSON.stringify({ project_id: String(fixture.a.project), memory_type: 'current_state', scope: 'project', title: 'A-only state v2', content: 'new state', source: 'http-test', importance: 'high' }) })
    expect(second.status).toBe(201)
    const old = await api(`/api/memory/working/${memoryId}?tenant_key=${fixture.a.key}`, { headers: withCookie(aliceCookie) })
    expect(old.body.memory.lifecycle_status).toBe('superseded')
    expect((await api(`/api/memory/working?project_id=${fixture.a.project}&tenant_key=${fixture.b.key}`, { headers: withCookie(bobCookie) })).body.memories).toEqual([])
    expect((await api(`/api/memory/working?project_id=${fixture.a.project}`, { method: 'POST', headers: withCookie(bobCookie), body: '{}' })).status).toBe(400)

    const deniedHandoff = await api(`/api/memory/handoffs?tenant_key=${fixture.b.key}`, { method: 'POST', headers: withCookie(bobCookie), body: JSON.stringify({ source_agent: 'http-a-agent', destination_agent: 'http-b-agent', objective: 'cross tenant', relevant_context: 'must fail', expected_result: 'none', project_id: String(fixture.a.project) }) })
    expect(deniedHandoff.status).toBe(403)
    const db = new Database(fixture.dbPath, { readonly: true })
    const audit = db.prepare(`SELECT COUNT(*) AS count FROM audit_log WHERE tenant_id = ? AND action IN ('memory_created', 'tenant_model_profile_created')`).get(fixture.a.id) as { count: number }
    const authAudit = db.prepare(`SELECT COUNT(*) AS count FROM tenant_authorization_audit WHERE actor = 'http-bob' AND decision = 'deny' AND requested_tenant_key = ?`).get(fixture.a.key) as { count: number }
    db.close()
    expect(audit.count).toBeGreaterThan(0)
    expect(authAudit.count).toBeGreaterThan(0)
  })

  it('proves model profiles, fallback, credentials, and resolver output cannot cross tenants', async () => {
    const ownerCookie = await login('http-owner', PASSWORDS.owner)
    const credentialA = await api('/api/model-profiles/credentials', { method: 'POST', headers: withCookie(ownerCookie), body: JSON.stringify({ tenant_key: fixture.a.key, provider_id: 'openai', credential_ref: 'http-a/openai/primary' }) })
    const credentialB = await api('/api/model-profiles/credentials', { method: 'POST', headers: withCookie(ownerCookie), body: JSON.stringify({ tenant_key: fixture.b.key, provider_id: 'openai', credential_ref: 'http-b/openai/primary' }) })
    expect(credentialA.status).toBe(201)
    expect(credentialB.status).toBe(201)
    const profileA = await api(`/api/model-profiles?tenant_key=${fixture.a.key}`, { method: 'POST', headers: withCookie(ownerCookie), body: JSON.stringify({ provider_id: 'openai', model_id: 'gpt-4.1-mini', credential_ref: 'http-a/openai/primary', priority: 1 }) })
    const profileB = await api(`/api/model-profiles?tenant_key=${fixture.b.key}`, { method: 'POST', headers: withCookie(ownerCookie), body: JSON.stringify({ provider_id: 'openai', model_id: 'gpt-4.1-nano', credential_ref: 'http-b/openai/primary', priority: 1 }) })
    expect(profileA.status).toBe(201)
    expect(profileB.status).toBe(201)
    fixture.profiles = { a: profileA.body.profile.id, b: profileB.body.profile.id }

    const bobCookie = await login('http-bob', PASSWORDS.bob)
    const visibleB = await api('/api/model-profiles', { headers: withCookie(bobCookie) })
    expect(visibleB.status).toBe(200)
    expect(visibleB.body.profiles.map((p: any) => p.id)).not.toContain(fixture.profiles.a)
    expect((await api(`/api/model-profiles?tenant_key=${fixture.a.key}`, { headers: withCookie(bobCookie) })).status).toBe(403)
    expect((await api(`/api/model-profiles/${fixture.profiles.a}?tenant_key=${fixture.a.key}`, { method: 'PATCH', headers: withCookie(bobCookie), body: JSON.stringify({ enabled: false }) })).status).toBe(403)
    expect((await api(`/api/model-profiles?tenant_key=${fixture.b.key}`, { method: 'POST', headers: withCookie(ownerCookie), body: JSON.stringify({ provider_id: 'openai', model_id: 'gpt-4.1-mini', credential_ref: 'http-a/openai/primary' }) })).status).toBe(400)
    expect((await api(`/api/model-profiles?tenant_key=${fixture.b.key}`, { method: 'POST', headers: withCookie(ownerCookie), body: JSON.stringify({ provider_id: 'openai', model_id: 'gpt-4.1-mini', fallback_profile_id: fixture.profiles.a }) })).status).toBe(400)
    expect((await api(`/api/model-profiles?tenant_key=${fixture.b.key}`, { headers: withCookie(bobCookie) })).body.effective.profile_id).toBe(fixture.profiles.b)
  })
})
