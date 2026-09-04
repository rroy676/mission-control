#!/usr/bin/env node
/**
 * Bounded authenticated working-memory validation.
 *
 * Credentials are supplied only by the caller's protected environment:
 *   MC_VALIDATION_BASE_URL, MC_VALIDATION_USERNAME, MC_VALIDATION_PASSWORD
 * No credential or secret-bearing request body is printed.
 */
import assert from 'node:assert/strict'

const baseUrl = (process.env.MC_VALIDATION_BASE_URL || 'https://mc.royfam.xyz').replace(/\/$/, '')
const username = process.env.MC_VALIDATION_USERNAME
const password = process.env.MC_VALIDATION_PASSWORD
if (!username || !password) throw new Error('Set MC_VALIDATION_USERNAME and MC_VALIDATION_PASSWORD in the protected runtime environment')

const cookieJar = new Map()
function absorbCookies(response) {
  const value = response.headers.get('set-cookie')
  if (!value) return
  for (const part of value.split(/,(?=\s*[^;,=]+=[^;,]+)/)) {
    const pair = part.split(';', 1)[0]
    const index = pair.indexOf('=')
    if (index > 0) cookieJar.set(pair.slice(0, index), pair.slice(index + 1))
  }
}
function cookieHeader() { return [...cookieJar].map(([key, value]) => `${key}=${value}`).join('; ') }
async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookieJar.size ? { cookie: cookieHeader() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  absorbCookies(response)
  let payload = null
  try { payload = await response.json() } catch {}
  return { response, payload }
}
function expectStatus(result, status, label) { assert.equal(result.response.status, status, `${label}: expected ${status}, got ${result.response.status}`) }
function memoryBody(overrides = {}) {
  return { scope: 'project', project_id: null, agent_id: null, task_id: null, memory_type: 'operational_note', title: `validation-${Date.now()}`, content: 'bounded validation context', source: 'operator-validation', importance: 'normal', ...overrides }
}

const login = await call('POST', '/api/auth/login', { username, password })
expectStatus(login, 200, 'authentication')
const me = await call('GET', '/api/auth/me')
expectStatus(me, 200, '/api/auth/me')
const tenants = await call('GET', '/api/tenants')
expectStatus(tenants, 200, 'active tenant')
const tenant = tenants.payload?.active_tenant
assert.ok(tenant?.tenant_key, 'active tenant key missing')
const projects = await call('GET', '/api/projects')
expectStatus(projects, 200, 'projects')
const project = projects.payload?.projects?.[0] || projects.payload?.[0]
assert.ok(project?.id, 'no project available for validation')

const created = await call('POST', `/api/memory/working?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { ...memoryBody({ project_id: String(project.id), title: 'validation CRUD item' }) })
expectStatus(created, 201, 'memory create')
const memory = created.payload?.memory
assert.ok(memory?.memory_id)
const exact = await call('GET', `/api/memory/working/${memory.memory_id}?tenant_key=${encodeURIComponent(tenant.tenant_key)}`)
expectStatus(exact, 200, 'memory exact read')
const queried = await call('GET', `/api/memory/working?tenant_key=${encodeURIComponent(tenant.tenant_key)}&project_id=${project.id}&memory_type=operational_note`)
expectStatus(queried, 200, 'memory query')
assert.ok(queried.payload.memories.some((item) => item.memory_id === memory.memory_id))
const updated = await call('PATCH', `/api/memory/working/${memory.memory_id}?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { lifecycle_status: 'resolved' })
expectStatus(updated, 200, 'memory bounded update')

const state1 = await call('POST', `/api/memory/working?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { ...memoryBody({ memory_type: 'current_state', importance: 'high', title: 'validation current state 1', content: 'old state', project_id: String(project.id) }) })
const state2 = await call('POST', `/api/memory/working?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { ...memoryBody({ memory_type: 'current_state', importance: 'high', title: 'validation current state 2', content: 'new state', project_id: String(project.id) }) })
expectStatus(state1, 201, 'current state create')
expectStatus(state2, 201, 'current state replacement')
const stateOld = await call('GET', `/api/memory/working/${state1.payload.memory.memory_id}?tenant_key=${encodeURIComponent(tenant.tenant_key)}`)
const stateNew = await call('GET', `/api/memory/working/${state2.payload.memory.memory_id}?tenant_key=${encodeURIComponent(tenant.tenant_key)}`)
expectStatus(stateOld, 200, 'historical current state read')
expectStatus(stateNew, 200, 'active current state read')
assert.equal(stateOld.payload.memory.lifecycle_status, 'superseded')
assert.equal(stateNew.payload.memory.lifecycle_status, 'active')

const agents = await call('GET', '/api/agents')
expectStatus(agents, 200, 'agents')
const agentRows = agents.payload?.agents || agents.payload || []
const hermes = agentRows.find((item) => item.name === 'Hermes')
const codex = agentRows.find((item) => item.name === 'Codex')
if (hermes && codex) {
  const handoff = await call('POST', `/api/memory/handoffs?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { project_id: String(project.id), source_agent: 'Hermes', destination_agent: 'Codex', objective: 'validation objective', relevant_context: 'context only; no execution authority', constraints: 'none', source_references: [], expected_result: 'validation result' })
  expectStatus(handoff, 201, 'handoff create')
  assert.equal(handoff.payload.handoff.tenant_id, tenant.tenant_key)
  const completed = await call('PATCH', `/api/memory/handoffs/${handoff.payload.handoff.memory_id}?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { status: 'completed' })
  expectStatus(completed, 200, 'handoff completion')
}

const candidate = await call('POST', `/api/memory/working?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { ...memoryBody({ memory_type: 'recent_decision', scope: 'project', project_id: String(project.id), title: 'validation promotion candidate', content: 'governance review required', importance: 'high' }) })
expectStatus(candidate, 201, 'promotion candidate create')
assert.equal(candidate.payload.memory.promotion_status, 'promotion-candidate')
assert.equal(candidate.payload.memory.durable_reference, null)

const activity = await call('GET', `/api/activities?tenant_key=${encodeURIComponent(tenant.tenant_key)}&entity_type=working_memory&limit=100`)
expectStatus(activity, 200, 'activity evidence')
const audit = await call('GET', `/api/audit?limit=100`)
expectStatus(audit, 200, 'audit evidence')
const auditText = JSON.stringify(audit.payload)
for (const id of [memory.memory_id, state1.payload.memory.memory_id, state2.payload.memory.memory_id, candidate.payload.memory.memory_id]) assert.ok(auditText.includes(id), `audit missing ${id}`)

for (const secret of [
  { content: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.validation' },
  { content: 'api_key=sk-validation-never-use' },
  { metadata: { password: 'validation-password' } },
  { content: 'session_cookie=mc-session.validation' },
  { content: '-----BEGIN PRIVATE KEY----- validation -----END PRIVATE KEY-----' },
]) {
  const rejected = await call('POST', `/api/memory/working?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, memoryBody({ project_id: String(project.id), ...secret }))
  assert.ok([400, 403].includes(rejected.response.status), `secret payload was accepted: ${rejected.response.status}`)
}

for (const path of ['/api/local/terminal', '/api/pty', '/api/spawn', '/api/gateways/control', '/api/super/tenants', '/api/openclaw/update', '/api/releases/update', '/api/pipelines/run', '/api/exec-approvals']) {
  const blocked = await call('POST', path, {})
  assert.equal(blocked.response.status, 403, `dangerous route ${path}`)
}

for (const id of [memory.memory_id, state1.payload.memory.memory_id, state2.payload.memory.memory_id, candidate.payload.memory.memory_id]) {
  const cleaned = await call('PATCH', `/api/memory/working/${id}?tenant_key=${encodeURIComponent(tenant.tenant_key)}`, { lifecycle_status: 'resolved' })
  expectStatus(cleaned, 200, `cleanup ${id}`)
}
console.log(JSON.stringify({ status: 'PASS', authenticated_user: me.payload?.user?.username, tenant_key: tenant.tenant_key, project_id: project.id, handoff: Boolean(hermes && codex), secret_cases: 5, dangerous_routes: 9, cleanup: 'resolved' }))
