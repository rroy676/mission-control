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
export const TASK14_RESEARCH_CHECKLIST = ['epiceries.ca developer/API documentation', 'Maxi/Loblaw', 'Metro', 'Super C', 'IGA/Sobeys', 'Walmart Canada', 'Giant Tiger', 'commercial-use uncertainty', 'sample API response/schema', 'final feasibility matrix'] as const

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

export function researchCounts(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'taskId' | 'runId'>) {
  const db = getDatabase()
  const evidence = db.prepare('SELECT COUNT(*) c FROM hermes_research_evidence WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=?').get(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId) as any
  const sources = db.prepare('SELECT COUNT(*) c FROM hermes_research_sources WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=?').get(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId) as any
  return { evidence_count: Number(evidence?.c || 0), source_count: Number(sources?.c || 0) }
}

export function researchChecklist(scope: Pick<Scope, 'tenantId' | 'workspaceId' | 'taskId' | 'runId'>) {
  const db = getDatabase()
  const rows = db.prepare('SELECT lower(COALESCE(entity, \'\')) entity, lower(source_url) url, lower(claim || \' \' || evidence_summary) text FROM hermes_research_evidence WHERE tenant_id=? AND workspace_id=? AND task_id=? AND run_id=?').all(scope.tenantId, scope.workspaceId, scope.taskId, scope.runId) as Array<{ entity: string; url: string; text: string }>
  const covered = (term: string) => rows.some((row) => `${row.entity} ${row.text} ${row.url}`.includes(term.toLowerCase()))
  return {
    'epiceries.ca developer/API documentation': rows.some((row) => row.url.includes('epiceries.ca') && /api|developer|documentation/.test(row.text)),
    'Maxi/Loblaw': covered('maxi') || covered('loblaw'), Metro: covered('metro'), 'Super C': covered('super c'), 'IGA/Sobeys': covered('iga') || covered('sobeys'), 'Walmart Canada': covered('walmart'), 'Giant Tiger': covered('giant tiger'), 'commercial-use uncertainty': covered('commercial'), 'sample API response/schema': covered('schema') || covered('field'), 'final feasibility matrix': covered('matrix'),
  }
}
