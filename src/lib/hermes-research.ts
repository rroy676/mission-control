import dns from 'node:dns/promises'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { getDatabase, logAuditEvent } from './db'

export const HERMES_RESEARCH_LIMITS = {
  maxIterations: 12,
  maxFetches: 12,
  maxSearches: 4,
  maxResponseBytes: 512_000,
  maxTextBytes: 120_000,
  timeoutMs: 8_000,
} as const

type Scope = { tenantId: number; workspaceId: number; projectId: number; taskId: number; runId: string }
export type ResearchStage = 'PLAN' | 'SEARCH' | 'SELECT_SOURCE' | 'FETCH' | 'EXTRACT_EVIDENCE' | 'PERSIST_EVIDENCE' | 'ASSESS_GAPS' | 'SYNTHESIZE' | 'VALIDATE_DELIVERABLE' | 'REVIEW'
export type ResearchRequirementStatus = 'PENDING' | 'IN_PROGRESS' | 'SATISFIED' | 'BLOCKED' | 'NOT_FOUND'
export type ResearchRequirement = { id: string; ordinal: number; phase: 'P0' | 'P1' | 'P2'; label: string; objective: string }
export const TASK14_RESEARCH_REQUIREMENTS: readonly ResearchRequirement[] = [
  { id: 'epiceries_docs', ordinal: 1, phase: 'P0', label: 'official épiceries.ca developer/API documentation', objective: 'Locate the official épiceries.ca developer or API documentation and establish whether it exists.' },
  { id: 'epiceries_fetch', ordinal: 2, phase: 'P0', label: 'fetch official épiceries.ca documentation', objective: 'Fetch the official épiceries.ca documentation URL using the bounded public fetch action.' },
  { id: 'epiceries_evidence', ordinal: 3, phase: 'P0', label: 'persist substantive épiceries.ca evidence', objective: 'Extract and persist substantive evidence from the fetched épiceries.ca documentation.' },
  { id: 'epiceries_endpoints', ordinal: 4, phase: 'P0', label: 'document épiceries.ca API endpoints', objective: 'Identify documented épiceries.ca endpoints and the fields or operations they expose.' },
  { id: 'epiceries_sample', ordinal: 5, phase: 'P0', label: 'bounded épiceries.ca API/sample inspection', objective: 'Perform a bounded read-only épiceries.ca API or sample inspection where permitted.' },
  { id: 'epiceries_schema', ordinal: 6, phase: 'P0', label: 'persist sanitized épiceries.ca schema/sample', objective: 'Persist a sanitized schema or sample response covering relevant price-data fields.' },
  { id: 'epiceries_access', ordinal: 7, phase: 'P0', label: 'authentication/update/rate guidance', objective: 'Identify evidenced authentication, update-frequency, rate, or usage guidance for épiceries.ca.' },
  { id: 'epiceries_commercial', ordinal: 8, phase: 'P0', label: 'épiceries.ca commercial-permission uncertainty', objective: 'Record what is and is not evidenced about épiceries.ca commercial permission; do not infer rights.' },
  { id: 'retailer_maxi', ordinal: 9, phase: 'P1', label: 'Maxi/Loblaw', objective: 'Assess Maxi/Loblaw with authoritative evidence or explicitly record that no authoritative source was located within the bounded research.' },
  { id: 'retailer_metro', ordinal: 10, phase: 'P1', label: 'Metro', objective: 'Assess Metro with authoritative evidence or explicitly record that no authoritative source was located within the bounded research.' },
  { id: 'retailer_super_c', ordinal: 11, phase: 'P1', label: 'Super C', objective: 'Assess Super C with authoritative evidence or explicitly record that no authoritative source was located within the bounded research.' },
  { id: 'retailer_iga', ordinal: 12, phase: 'P1', label: 'IGA/Sobeys', objective: 'Assess IGA/Sobeys with authoritative evidence or explicitly record that no authoritative source was located within the bounded research.' },
  { id: 'retailer_walmart', ordinal: 13, phase: 'P1', label: 'Walmart Canada', objective: 'Assess Walmart Canada with authoritative evidence or explicitly record that no authoritative source was located within the bounded research.' },
  { id: 'retailer_giant_tiger', ordinal: 14, phase: 'P1', label: 'Giant Tiger', objective: 'Assess Giant Tiger with authoritative evidence or explicitly record that no authoritative source was located within the bounded research.' },
  { id: 'technical_matrix', ordinal: 15, phase: 'P2', label: 'technical feasibility matrix', objective: 'Synthesize an evidence-backed technical feasibility matrix for all six retailers.' },
  { id: 'commercial_matrix', ordinal: 16, phase: 'P2', label: 'commercial/legal uncertainty matrix', objective: 'Synthesize an evidence-backed commercial and legal uncertainty matrix.' },
  { id: 'primary_poc', ordinal: 17, phase: 'P2', label: 'primary POC recommendation', objective: 'Recommend a primary POC source using persisted evidence.' },
  { id: 'fallback', ordinal: 18, phase: 'P2', label: 'backup/fallback strategy', objective: 'Define an evidence-backed backup or fallback data strategy.' },
  { id: 'avoid', ordinal: 19, phase: 'P2', label: 'sources/approaches to avoid', objective: 'Identify sources or approaches to avoid for now, with evidence.' },
  { id: 'permission_questions', ordinal: 20, phase: 'P2', label: 'unresolved permission questions', objective: 'List unresolved permission, licensing, attribution, and legal questions.' },
  { id: 'recommendation', ordinal: 21, phase: 'P2', label: 'GO / CONDITIONAL GO / NO-GO', objective: 'Make the final evidence-backed GO, CONDITIONAL GO, or NO-GO recommendation.' },
] as const
export const TASK14_RESEARCH_CHECKLIST = TASK14_RESEARCH_REQUIREMENTS.map((requirement) => requirement.label)

function privateIp(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase()
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
  }
  return true
}

type DnsResolver = (hostname: string, options: { all: true }) => Promise<Array<{ address: string }>>
export async function validatePublicHttpsUrl(raw: string, resolve: DnsResolver = dns.lookup as DnsResolver): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Only public HTTPS URLs are allowed') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('Only public HTTPS URLs are allowed')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') throw new Error('Private and metadata hosts are not allowed')
  const addresses = net.isIP(host) ? [host] : (await resolve(host, { all: true })).map((entry: any) => entry.address)
  if (!addresses.length || addresses.some(privateIp)) throw new Error('Private and metadata network addresses are not allowed')
  return url
}

async function boundedFetch(rawUrl: string, kind: 'html' | 'json', scope: Scope) {
  let url = await validatePublicHttpsUrl(rawUrl)
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(HERMES_RESEARCH_LIMITS.timeoutMs), headers: { Accept: kind === 'json' ? 'application/json' : 'text/html, text/plain, application/json', 'User-Agent': 'Mission-Control-Hermes-Research/1.0' } })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) { url = await validatePublicHttpsUrl(new URL(location, url).toString()); continue }
    if (!response.ok) throw new Error(`Public source returned HTTP ${response.status}`)
    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    const allowed = kind === 'json' ? contentType.includes('json') : contentType.includes('html') || contentType.includes('text/plain') || contentType.includes('json')
    if (!allowed) throw new Error(`Unsupported source content type: ${contentType || 'missing'}`)
    const length = Number(response.headers.get('content-length') || 0)
    if (length > HERMES_RESEARCH_LIMITS.maxResponseBytes) throw new Error('Source response exceeds the bounded size limit')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > HERMES_RESEARCH_LIMITS.maxResponseBytes) throw new Error('Source response exceeds the bounded size limit')
    const text = buffer.toString('utf8').slice(0, HERMES_RESEARCH_LIMITS.maxTextBytes)
    const sourceId = persistSource(scope, url.toString(), response.headers.get('content-type') || '', text, { finalUrl: url.toString(), httpStatus: response.status, outcome: 'SUCCESS' })
    saveFetchObservation(scope, sourceId, url.toString(), response.headers.get('content-type') || '')
    return { source_id: sourceId, url: url.toString(), status: response.status, contentType, text, truncated: buffer.byteLength > HERMES_RESEARCH_LIMITS.maxTextBytes }
  }
  throw new Error('Too many redirects')
}

export function persistResearchSource(scope: Scope, input: { url: string; finalUrl?: string; title?: string; publisher?: string; httpStatus?: number; contentType?: string; contentExcerpt?: string; contentHash?: string; outcome?: string; selected?: boolean; rejectionReason?: string }) {
  const db = getDatabase()
  const result = db.prepare(`INSERT INTO hermes_research_sources (tenant_id,workspace_id,project_id,task_id,run_id,url,content_type,content_excerpt,retrieved_at,final_url,title,publisher,http_status,content_hash,fetch_outcome,selected,rejection_reason)
    VALUES (?,?,?,?,?,?,?,?,unixepoch(),?,?,?,?,?,?,?,?)`).run(scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId, scope.runId, input.url, (input.contentType || '').slice(0, 120), (input.contentExcerpt || '').slice(0, HERMES_RESEARCH_LIMITS.maxTextBytes), input.finalUrl || input.url, (input.title || '').slice(0, 500), (input.publisher || new URL(input.url).hostname).slice(0, 200), input.httpStatus ?? null, input.contentHash || null, input.outcome || 'SUCCESS', input.selected ? 1 : 0, input.rejectionReason || null)
  return Number(result.lastInsertRowid)
}

function saveFetchObservation(scope: Scope, sourceId: number, url: string, contentType: string) {
  const db = getDatabase()
  db.prepare(`INSERT INTO hermes_research_evidence (tenant_id,workspace_id,project_id,task_id,run_id,source_url,source_title,publisher,claim,evidence_summary,confidence,classification,retrieved_at,source_id,entity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),?,?)`).run(scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId, scope.runId, url, 'Public source retrieval', new URL(url).hostname, 'The public source was retrieved successfully.', `Mission Control retrieved this source as ${contentType || 'an allowed public response'} during the bounded research run.`, 'high', 'VERIFIED', sourceId, 'source-retrieval')
}

function persistSource(scope: Scope, url: string, contentType: string, text: string, detail: { finalUrl: string; httpStatus: number; outcome: string }) {
  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM hermes_research_sources WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=? AND url=?').get(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId, url) as { id?: number } | undefined
  if (existing?.id) return existing.id
  return persistResearchSource(scope, { url, finalUrl: detail.finalUrl, contentType, contentExcerpt: text, httpStatus: detail.httpStatus, contentHash: createHash('sha256').update(text).digest('hex'), outcome: detail.outcome })
}

export async function searchPublicWeb(query: string, scope: Scope) {
  if (!query.trim() || query.length > 500) throw new Error('Search query is invalid')
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const db = getDatabase()
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalizedQuery)}`
  const prior = db.prepare('SELECT id FROM hermes_research_sources WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=? AND url=?').get(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId, endpoint) as { id?: number } | undefined
  if (prior?.id) return { duplicate: true, query: normalizedQuery, results: [] }
  const result = await boundedFetch(endpoint, 'html', scope)
  const results = [...result.text.matchAll(/result__a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 8).map((m) => ({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() }))
  return { query: query.trim(), source_url: result.url, results }
}

export async function fetchPublicUrl(rawUrl: string, scope: Scope) { return boundedFetch(rawUrl, 'html', scope) }
export async function fetchPublicJsonApi(rawUrl: string, scope: Scope) { return boundedFetch(rawUrl, 'json', scope) }

export function recordResearchFailure(scope: Scope, url: string, reason: string, status?: number) {
  return persistResearchSource(scope, { url, finalUrl: url, httpStatus: status, outcome: 'FAILED', rejectionReason: reason })
}

export function markResearchSourceSelected(scope: Scope, sourceId: number, selected: boolean, reason?: string) {
  getDatabase().prepare('UPDATE hermes_research_sources SET selected=?, rejection_reason=? WHERE id=? AND tenant_id=? AND workspace_id=? AND task_id=? AND run_id=?').run(selected ? 1 : 0, reason || null, sourceId, scope.tenantId, scope.workspaceId, scope.taskId, scope.runId)
}

export function saveHermesEvidence(scope: Scope, input: { url: string; title: string; publisher?: string; claim: string; summary: string; quote?: string; confidence: 'high' | 'medium' | 'low'; classification: 'VERIFIED' | 'INFERRED' | 'UNVERIFIED' | 'CONFLICTING'; entity?: string; sourceId?: number }) {
  if (!/^https:\/\//i.test(input.url) || input.claim.length > 2_000 || input.summary.length > 4_000) throw new Error('Evidence is invalid')
  const quote = input.quote?.slice(0, 600) || null
  const db = getDatabase()
  const result = db.prepare(`INSERT INTO hermes_research_evidence (tenant_id,workspace_id,project_id,task_id,run_id,source_url,source_title,publisher,claim,evidence_summary,quoted_fragment,confidence,classification,retrieved_at,source_id,entity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),?,?)`).run(scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId, scope.runId, input.url, input.title.slice(0, 500), (input.publisher || new URL(input.url).hostname).slice(0, 200), input.claim, input.summary, quote, input.confidence, input.classification, input.sourceId || null, input.entity || null)
  logAuditEvent({ action: 'hermes.research.evidence_saved', actor: 'Hermes', target_type: 'hermes_research_evidence', target_id: Number(result.lastInsertRowid), detail: { ...scope, source_url: input.url, classification: input.classification }, workspace_id: scope.workspaceId, tenant_id: scope.tenantId })
  return { evidence_id: Number(result.lastInsertRowid), classification: input.classification, source_url: input.url }
}

function task14RequirementEvidence(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'>) {
  const db = getDatabase()
  return db.prepare(`SELECT id, source_url, claim, evidence_summary, entity, classification, source_id
    FROM hermes_research_evidence
    WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND COALESCE(entity, '') != 'source-retrieval'
    ORDER BY id`).all(scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId) as Array<{ id: number; source_url: string; claim: string; evidence_summary: string; entity: string | null; classification: string; source_id: number | null }>
}

function requirementMatches(requirement: ResearchRequirement, rows: ReturnType<typeof task14RequirementEvidence>) {
  const text = rows.map((row) => `${row.entity || ''} ${row.source_url} ${row.claim} ${row.evidence_summary}`.toLowerCase()).join('\n')
  const has = (...terms: string[]) => terms.every((term) => text.includes(term))
  if (requirement.id === 'epiceries_docs') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca') && /api|developer|documentation/.test(`${row.claim} ${row.evidence_summary}`.toLowerCase()))
  if (requirement.id === 'epiceries_fetch') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca'))
  if (requirement.id === 'epiceries_evidence') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca') && row.claim.trim().length > 20)
  if (requirement.id === 'epiceries_endpoints') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca') && /endpoint|api|route|operation/.test(`${row.claim} ${row.evidence_summary}`.toLowerCase()))
  if (requirement.id === 'epiceries_sample') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca') && /sample|response|json|api/.test(`${row.claim} ${row.evidence_summary}`.toLowerCase()))
  if (requirement.id === 'epiceries_schema') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca') && /schema|field|product|price/.test(`${row.claim} ${row.evidence_summary}`.toLowerCase()))
  if (requirement.id === 'epiceries_access') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca') && /auth|rate|update|frequency|usage/.test(`${row.claim} ${row.evidence_summary}`.toLowerCase()))
  if (requirement.id === 'epiceries_commercial') return rows.some((row) => row.source_url.toLowerCase().includes('epiceries.ca') && /commercial|permission|license|licens|terms|attribution/.test(`${row.claim} ${row.evidence_summary}`.toLowerCase()))
  if (requirement.id.startsWith('retailer_')) {
    const terms: Record<string, string[]> = { retailer_maxi: ['maxi'], retailer_metro: ['metro'], retailer_super_c: ['super c'], retailer_iga: ['iga'], retailer_walmart: ['walmart'], retailer_giant_tiger: ['giant tiger'] }
    return has(...(terms[requirement.id] || []))
  }
  return false
}

export function ensureResearchChecklist(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'>) {
  const db = getDatabase()
  const insert = db.prepare(`INSERT OR IGNORE INTO hermes_research_requirements
    (tenant_id,workspace_id,project_id,task_id,requirement_id,ordinal,phase,label,status,source_ids,evidence_ids,action_refs,updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'PENDING','[]','[]','[]',unixepoch())`)
  const transaction = db.transaction(() => { for (const requirement of TASK14_RESEARCH_REQUIREMENTS) insert.run(scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId, requirement.id, requirement.ordinal, requirement.phase, requirement.label) })
  transaction()
  return refreshResearchChecklist(scope)
}

export function refreshResearchChecklist(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'>) {
  const db = getDatabase()
  const rows = task14RequirementEvidence(scope)
  const requirements = db.prepare('SELECT requirement_id, status, source_ids, evidence_ids, action_refs FROM hermes_research_requirements WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? ORDER BY ordinal').all(scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId) as Array<{ requirement_id: string; status: ResearchRequirementStatus; source_ids: string; evidence_ids: string; action_refs: string }>
  const update = db.prepare(`UPDATE hermes_research_requirements SET status=?, source_ids=?, evidence_ids=?, updated_at=unixepoch() WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND requirement_id=?`)
  for (const row of requirements) {
    const requirement = TASK14_RESEARCH_REQUIREMENTS.find((item) => item.id === row.requirement_id)
    if (!requirement || row.status === 'BLOCKED' || row.status === 'NOT_FOUND') continue
    if (requirementMatches(requirement, rows)) {
      const ids = rows.filter((e) => requirementMatches(requirement, [e])).map((e) => e.id)
      const sourceIds = rows.filter((e) => requirementMatches(requirement, [e]) && e.source_id).map((e) => e.source_id)
      update.run('SATISFIED', JSON.stringify(sourceIds), JSON.stringify(ids), scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId, row.requirement_id)
    }
  }
  return getResearchChecklistState(scope)
}

export function getResearchChecklistState(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'>) {
  const db = getDatabase()
  return db.prepare(`SELECT requirement_id,ordinal,phase,label,status,source_ids,evidence_ids,action_refs,updated_at,claimed_by_run_id,claimed_at
    FROM hermes_research_requirements WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? ORDER BY ordinal`).all(scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId) as Array<{ requirement_id: string; ordinal: number; phase: string; label: string; status: ResearchRequirementStatus; source_ids: string; evidence_ids: string; action_refs: string; updated_at: number; claimed_by_run_id: string | null; claimed_at: number | null }>
}

export function recoverStaleResearchClaims(scope?: Pick<Scope, 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'>, staleAfterSeconds = 2 * 60) {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(`SELECT r.*, run.status AS run_status, run.heartbeat_at, run.completed_at, run.stop_reason
    FROM hermes_research_requirements r
    LEFT JOIN hermes_coo_runs run ON run.run_id = r.claimed_by_run_id
    WHERE r.status = 'IN_PROGRESS'
      ${scope ? 'AND r.tenant_id=? AND r.workspace_id=? AND r.project_id=? AND r.task_id=?' : ''}`).all(...(scope ? [scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId] : [])) as Array<any>
  const recover = db.prepare(`UPDATE hermes_research_requirements
    SET status='PENDING', claimed_by_run_id=NULL, claimed_at=NULL,
        action_refs=json_insert(COALESCE(action_refs,'[]'),'$[#]',?), updated_at=?
    WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND requirement_id=? AND status='IN_PROGRESS' AND claimed_by_run_id IS ?`)
  let recovered = 0
  for (const row of rows) {
    const active = row.run_status === 'QUEUED' || row.run_status === 'WAITING_FOR_CEO' || (row.run_status === 'RUNNING' && Number(row.heartbeat_at || 0) >= now - staleAfterSeconds)
    if (active) continue
    const reason = row.run_status ? `owning run ${row.run_status.toLowerCase()}` : 'owning run missing'
    const previousRunId = row.claimed_by_run_id || null
    const recovery = JSON.stringify({ event: 'RESEARCH_REQUIREMENT_CLAIM_RECOVERED', previous_run_id: previousRunId, reason, recovered_at: now })
    const result = recover.run(recovery, now, row.tenant_id, row.workspace_id, row.project_id, row.task_id, row.requirement_id, previousRunId)
    if (result.changes !== 1) continue
    recovered += 1
    logAuditEvent({
      action: 'RESEARCH_REQUIREMENT_CLAIM_RECOVERED',
      actor: 'Mission Control',
      target_type: 'hermes_research_requirement',
      detail: { tenant_id: row.tenant_id, workspace_id: row.workspace_id, project_id: row.project_id, task_id: row.task_id, requirement_id: row.requirement_id, previous_run_id: previousRunId, previous_status: 'IN_PROGRESS', new_status: 'PENDING', reason },
      workspace_id: row.workspace_id,
      tenant_id: row.tenant_id,
    })
  }
  return recovered
}

export function beginNextResearchRequirement(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'>, runId: string) {
  ensureResearchChecklist(scope)
  recoverStaleResearchClaims(scope)
  const db = getDatabase()
  const rows = getResearchChecklistState(scope)
  const next = rows.find((row) => row.status === 'PENDING' || row.status === 'IN_PROGRESS')
  if (!next) return null
  if (next.status === 'IN_PROGRESS' && next.claimed_by_run_id !== runId) return null
  if (next.status === 'PENDING') {
    const claimed = db.prepare(`UPDATE hermes_research_requirements SET status='IN_PROGRESS', claimed_by_run_id=?, claimed_at=unixepoch(), action_refs=json_insert(COALESCE(action_refs,'[]'),'$[#]',?), updated_at=unixepoch()
      WHERE tenant_id=? AND workspace_id=? AND project_id=? AND task_id=? AND requirement_id=? AND status='PENDING'`).run(runId, JSON.stringify({ run_id: runId, event: 'RESEARCH_REQUIREMENT_CLAIMED' }), scope.tenantId, scope.workspaceId, scope.projectId, scope.taskId, next.requirement_id)
    if (claimed.changes !== 1) return null
  }
  const requirement = TASK14_RESEARCH_REQUIREMENTS.find((item) => item.id === next.requirement_id)
  return requirement ? { ...requirement, status: next.status === 'PENDING' ? 'IN_PROGRESS' as const : next.status } : null
}

export function compactResearchContext(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'projectId' | 'taskId'>, runId: string) {
  const checklist = refreshResearchChecklist(scope)
  const current = checklist.find((row) => row.status === 'PENDING' || row.status === 'IN_PROGRESS')
  const relevant = task14RequirementEvidence(scope).filter((row) => current && `${row.entity || ''} ${row.claim} ${row.evidence_summary}`.toLowerCase().includes(current.label.toLowerCase().split('/')[0].split(' ')[0])).slice(-4)
  return {
    run_id: runId,
    current_requirement: current ? { id: current.requirement_id, phase: current.phase, label: current.label, status: current.status } : null,
    checklist: checklist.map((row) => ({ id: row.requirement_id, phase: row.phase, status: row.status })),
    relevant_evidence: relevant.map((row) => ({ evidence_id: row.id, source_id: row.source_id, url: row.source_url, entity: row.entity, classification: row.classification, claim: row.claim.slice(0, 500), summary: row.evidence_summary.slice(0, 700) })),
  }
}

export function researchCounts(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'taskId' | 'runId'>) {
  const db = getDatabase()
  const evidence = db.prepare('SELECT COUNT(*) c FROM hermes_research_evidence WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=?').get(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId) as any
  const sources = db.prepare('SELECT COUNT(*) c FROM hermes_research_sources WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=?').get(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId) as any
  return { evidence_count: Number(evidence?.c || 0), source_count: Number(sources?.c || 0) }
}

export function researchChecklist(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'taskId' | 'runId'>) {
  const db = getDatabase()
  const persisted = db.prepare(`SELECT requirement_id,status FROM hermes_research_requirements
    WHERE tenant_id=? AND workspace_id=? AND task_id=? ORDER BY ordinal`).all(scope.tenantId, scope.workspaceId, scope.taskId) as Array<{ requirement_id: string; status: ResearchRequirementStatus }>
  if (persisted.length) {
    const satisfied = (id: string) => persisted.some((row) => row.requirement_id === id && row.status === 'SATISFIED')
    return {
      'epiceries.ca developer/API documentation': satisfied('epiceries_docs') && satisfied('epiceries_evidence'),
      'Maxi/Loblaw': satisfied('retailer_maxi'),
      Metro: satisfied('retailer_metro'),
      'Super C': satisfied('retailer_super_c'),
      'IGA/Sobeys': satisfied('retailer_iga'),
      'Walmart Canada': satisfied('retailer_walmart'),
      'Giant Tiger': satisfied('retailer_giant_tiger'),
      'commercial-use uncertainty': satisfied('epiceries_commercial') && satisfied('commercial_matrix'),
      'sample API response/schema': satisfied('epiceries_sample') && satisfied('epiceries_schema'),
      'final feasibility matrix': satisfied('technical_matrix') && satisfied('commercial_matrix') && satisfied('recommendation'),
    }
  }
  const rows = db.prepare('SELECT lower(COALESCE(entity, \'\')) entity, lower(source_url) url, lower(claim || \' \' || evidence_summary) text FROM hermes_research_evidence WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=?').all(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId) as Array<{ entity: string; url: string; text: string }>
  const covered = (term: string) => rows.some((row) => `${row.entity} ${row.text} ${row.url}`.includes(term.toLowerCase()))
  return {
    'epiceries.ca developer/API documentation': rows.some((row) => row.url.includes('epiceries.ca') && /api|developer|documentation/.test(row.text)),
    'Maxi/Loblaw': covered('maxi') || covered('loblaw'), Metro: covered('metro'), 'Super C': covered('super c'), 'IGA/Sobeys': covered('iga') || covered('sobeys'), 'Walmart Canada': covered('walmart'), 'Giant Tiger': covered('giant tiger'), 'commercial-use uncertainty': covered('commercial'), 'sample API response/schema': covered('schema') || covered('field'), 'final feasibility matrix': covered('matrix'),
  }
}
