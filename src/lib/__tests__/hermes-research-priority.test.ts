import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Database.Database | null, audit: vi.fn() }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  logAuditEvent: state.audit,
}))

import { beginNextResearchRequirement, compactResearchContext, ensureResearchChecklist, getResearchChecklistState, recoverStaleResearchClaims, refreshResearchChecklist, researchActionCompatibility, researchExecutionContract } from '@/lib/hermes-research'

const scope = { tenantId: 1, workspaceId: 1, projectId: 7, taskId: 14 }

function insertEvidence(input: { tenantId?: number; url: string; claim: string; summary?: string; entity?: string }) {
  state.db?.prepare(`INSERT OR IGNORE INTO hermes_research_sources
    (id,tenant_id,workspace_id,project_id,task_id,run_id,url,content_type,content_excerpt,http_status,fetch_outcome)
    VALUES (1,?,?,?,?,?,'https://epiceries.ca/developers','text/html','Base URL is https://epiceries.ca/api. GET /api?endpoint=categories and GET /api?endpoint=search&q=lait',200,'SUCCESS')`).run(input.tenantId ?? 1, 1, 7, 14, 'run-1')
  state.db?.prepare(`INSERT INTO hermes_research_evidence
    (tenant_id,workspace_id,project_id,task_id,run_id,source_url,source_title,publisher,claim,evidence_summary,confidence,classification,retrieved_at,source_id,entity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.tenantId ?? 1, 1, 7, 14, 'run-1', input.url, 'Source', 'Publisher', input.claim, input.summary || 'Summary', 'high', 'VERIFIED', 1, 1, input.entity || null)
}

function insertSource(input: { id: number; url: string; contentType?: string; runId?: string }) {
  state.db?.prepare(`INSERT INTO hermes_research_sources
    (id,tenant_id,workspace_id,project_id,task_id,run_id,url,content_type,content_excerpt,http_status,fetch_outcome)
    VALUES (?,?,?,?,?,?,?,?,?,200,'SUCCESS')`).run(input.id, 1, 1, 7, 14, input.runId || 'run-1', input.url, input.contentType || 'text/html', '')
}

describe('priority-aware resumable research checklist', () => {
  beforeEach(() => {
    state.db = new Database(':memory:')
    state.db.exec(`
      CREATE TABLE hermes_research_requirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, workspace_id INTEGER, project_id INTEGER, task_id INTEGER,
        requirement_id TEXT, ordinal INTEGER, phase TEXT, label TEXT, status TEXT, source_ids TEXT, evidence_ids TEXT, action_refs TEXT, updated_at INTEGER,
        claimed_by_run_id TEXT, claimed_at INTEGER,
        UNIQUE (tenant_id,workspace_id,project_id,task_id,requirement_id)
      );
      CREATE TABLE hermes_coo_runs (
        run_id TEXT PRIMARY KEY, tenant_id INTEGER, workspace_id INTEGER, project_id INTEGER, task_id INTEGER,
        status TEXT, heartbeat_at INTEGER, completed_at INTEGER, stop_reason TEXT
      );
      CREATE TABLE hermes_research_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, workspace_id INTEGER, project_id INTEGER, task_id INTEGER,
        run_id TEXT, source_url TEXT, source_title TEXT, publisher TEXT, claim TEXT, evidence_summary TEXT,
        confidence TEXT, classification TEXT, retrieved_at INTEGER, source_id INTEGER, entity TEXT
      );
      CREATE TABLE hermes_research_sources (
        id INTEGER PRIMARY KEY, tenant_id INTEGER, workspace_id INTEGER, project_id INTEGER, task_id INTEGER,
        run_id TEXT, url TEXT, content_type TEXT, content_excerpt TEXT, http_status INTEGER, fetch_outcome TEXT
      );
    `)
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    state.audit.mockReset()
  })

  it('selects the highest-priority unmet requirement first', () => {
    expect(beginNextResearchRequirement(scope, 'run-1')?.id).toBe('epiceries_docs')
  })

  it('requires evidence before marking a requirement satisfied', () => {
    ensureResearchChecklist(scope)
    expect(getResearchChecklistState(scope)[0].status).toBe('PENDING')
    insertEvidence({ url: 'https://example.test/source', claim: 'unrelated retailer information' })
    refreshResearchChecklist(scope)
    expect(getResearchChecklistState(scope)[0].status).toBe('PENDING')
  })

  it('advances after evidence satisfies the current requirement', () => {
    expect(beginNextResearchRequirement(scope, 'run-1')?.id).toBe('epiceries_docs')
    insertEvidence({ url: 'https://epiceries.ca/developers', claim: 'Official API documentation describes an endpoint and response fields.', entity: 'epiceries.ca' })
    const next = beginNextResearchRequirement(scope, 'run-1')
    const docs = getResearchChecklistState(scope).find((row) => row.requirement_id === 'epiceries_docs')
    expect(docs).toMatchObject({ status: 'SATISFIED', claimed_by_run_id: null, claimed_at: null })
    expect(JSON.parse(docs?.source_ids || '[]')).toEqual([1])
    expect(JSON.parse(docs?.evidence_ids || '[]')).toEqual([1])
    expect(next?.id).toBe('epiceries_sample')
  })

  it('skips explicitly blocked requirements and resumes the next one', () => {
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='BLOCKED' WHERE requirement_id='epiceries_docs'").run()
    expect(beginNextResearchRequirement(scope, 'run-1')?.id).toBe('epiceries_fetch')
  })

  it('cannot satisfy a requirement with foreign-tenant evidence', () => {
    insertEvidence({ tenantId: 2, url: 'https://epiceries.ca/developers', claim: 'Official API documentation and schema fields.', entity: 'epiceries.ca' })
    ensureResearchChecklist(scope)
    refreshResearchChecklist(scope)
    expect(getResearchChecklistState(scope)[0].status).toBe('PENDING')
  })

  it('keeps unrelated evidence out of compact current-objective context', () => {
    insertEvidence({ url: 'https://maxi.ca/products', claim: 'Maxi product information and price fields.', entity: 'Maxi' })
    ensureResearchChecklist(scope)
    const context = compactResearchContext(scope, 'run-1')
    expect(JSON.stringify(context)).not.toContain('maxi.ca')
    expect(context.current_requirement?.id).toBe('epiceries_docs')
  })

  it('protects a requirement claimed by an active run', () => {
    ensureResearchChecklist(scope)
    expect(beginNextResearchRequirement(scope, 'active-run')?.id).toBe('epiceries_docs')
    state.db?.prepare("INSERT INTO hermes_coo_runs (run_id,tenant_id,workspace_id,project_id,task_id,status,heartbeat_at) VALUES ('active-run',1,1,7,14,'RUNNING',strftime('%s','now'))").run()
    expect(beginNextResearchRequirement(scope, 'other-run')).toBeNull()
    expect(getResearchChecklistState(scope)[0].claimed_by_run_id).toBe('active-run')
  })

  it('recovers a failed claim without deleting evidence or action history', () => {
    ensureResearchChecklist(scope)
    expect(beginNextResearchRequirement(scope, 'failed-run')?.id).toBe('epiceries_docs')
    insertEvidence({ url: 'https://example.com/partial', claim: 'Partial durable evidence' })
    state.db?.prepare("INSERT INTO hermes_coo_runs (run_id,tenant_id,workspace_id,project_id,task_id,status,completed_at,stop_reason) VALUES ('failed-run',1,1,7,14,'FAILED',2,'parser failure')").run()
    expect(recoverStaleResearchClaims(scope)).toBe(1)
    const row = getResearchChecklistState(scope)[0]
    expect(row.status).toBe('PENDING')
    expect(row.claimed_by_run_id).toBeNull()
    expect(JSON.parse(row.action_refs).some((item: any) => (typeof item === 'string' ? JSON.parse(item) : item).event === 'RESEARCH_REQUIREMENT_CLAIM_RECOVERED')).toBe(true)
    expect(state.db?.prepare('SELECT COUNT(*) c FROM hermes_research_evidence').get()).toEqual({ c: 1 })
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESEARCH_REQUIREMENT_CLAIM_RECOVERED' }))
  })

  it('recovers a claim whose owning run is missing', () => {
    ensureResearchChecklist(scope)
    beginNextResearchRequirement(scope, 'missing-run')
    expect(recoverStaleResearchClaims(scope)).toBe(1)
    expect(getResearchChecklistState(scope)[0].status).toBe('PENDING')
  })

  it('does not satisfy API sample from documentation prose alone', () => {
    insertEvidence({ url: 'https://epiceries.ca/developers', claim: 'Official documentation describes a public JSON API response and product fields.', entity: 'epiceries.ca' })
    ensureResearchChecklist(scope)
    expect(getResearchChecklistState(scope).find((row) => row.requirement_id === 'epiceries_sample')?.status).toBe('PENDING')
  })

  it('requires an accepted JSON API action and successful JSON source for sample', () => {
    insertSource({ id: 2, url: 'https://epiceries.ca/api', contentType: 'application/json' })
    insertEvidence({ url: 'https://epiceries.ca/api', claim: 'The bounded API response exposed product and price fields.', entity: 'epiceries.ca' })
    state.db?.prepare("UPDATE hermes_research_evidence SET source_id=2 WHERE id=(SELECT max(id) FROM hermes_research_evidence)").run()
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET action_refs='[{\"action\":\"FETCH_PUBLIC_JSON_API\",\"accepted\":true}]' WHERE requirement_id='epiceries_sample'").run()
    refreshResearchChecklist(scope)
    expect(getResearchChecklistState(scope).find((row) => row.requirement_id === 'epiceries_sample')?.status).toBe('SATISFIED')
  })

  it('does not let an epiceries supported-store list satisfy direct retailer feasibility', () => {
    insertEvidence({ url: 'https://epiceries.ca/developers', claim: 'Official documentation lists Maxi, Metro, IGA, Walmart, Super C and Giant Tiger as supported stores.', entity: 'epiceries.ca' })
    ensureResearchChecklist(scope)
    refreshResearchChecklist(scope)
    expect(getResearchChecklistState(scope).filter((row) => row.requirement_id.startsWith('retailer_')).every((row) => row.status === 'PENDING')).toBe(true)
  })

  it('guides retailer Maxi research to the accessible JSON API and retailer-specific evidence', () => {
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='SATISFIED' WHERE ordinal < 9").run()
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='retailer_maxi'").run()
    const contract = researchExecutionContract(scope, 'retailer_maxi', 'current-run')
    expect(contract).toMatchObject({ requiredActionTypes: ['FETCH_PUBLIC_JSON_API'], usefulActionTypes: ['FETCH_PUBLIC_JSON_API'], currentRunSourceIds: [] })
    expect(contract?.knownFacts.join(' ')).toContain('store=Maxi')
    expect(contract?.knownFacts.join(' ')).toContain('generic epiceries.ca supported-store list does not satisfy')
    expect(researchActionCompatibility(scope, 'FETCH_PUBLIC_URL', 'current-run')).toMatchObject({ compatible: false, code: 'ACTION_NOT_COMPATIBLE_WITH_CURRENT_REQUIREMENT' })
  })

  it('gives retailer fallback guidance as one FETCH_PUBLIC_JSON_API action', () => {
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='retailer_metro'").run()
    const contract = researchExecutionContract(scope, 'retailer_metro', 'new-run')
    expect(contract?.knownFacts).toEqual(expect.arrayContaining([
      expect.stringContaining('emit only one fallback FETCH_PUBLIC_JSON_API action'),
      expect.stringContaining('Every research turn must contain exactly one action'),
    ]))
  })

  it('prefers SAVE_RESEARCH_EVIDENCE once retailer Maxi has a current-run JSON source', () => {
    insertSource({ id: 47, url: 'https://epiceries.ca/api?endpoint=search&q=lait&limit=20', contentType: 'application/json', runId: 'current-run' })
    state.db?.prepare("UPDATE hermes_research_sources SET content_excerpt=? WHERE id=47").run('{"results":[{"name":"Lait","price":2.49,"store":"Maxi","secret":"do-not-resend"}],"updated":"today"}')
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='SATISFIED' WHERE ordinal < 9").run()
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='retailer_maxi'").run()
    const contract = researchExecutionContract(scope, 'retailer_maxi', 'current-run')
    expect(contract).toMatchObject({ requiredActionTypes: ['SAVE_RESEARCH_EVIDENCE'], usefulActionTypes: ['SAVE_RESEARCH_EVIDENCE'], currentRunSourceIds: [47], relevantSourceIds: [47] })
    expect(contract?.knownFacts.join(' ')).toContain('Current-run source ID 47')
    expect(contract?.knownFacts.join(' ')).toContain('observed store values: Maxi')
    expect(contract?.knownFacts.join(' ')).toContain('Claim shape:')
    expect(contract?.knownFacts.join(' ')).toContain('Summary shape:')
    expect(contract?.knownFacts.join(' ')).not.toContain('do-not-resend')
    expect(researchActionCompatibility(scope, 'FETCH_PUBLIC_JSON_API', 'current-run')).toMatchObject({ compatible: false, code: 'ACTION_NOT_COMPATIBLE_WITH_CURRENT_REQUIREMENT' })
    expect(researchActionCompatibility(scope, 'SAVE_RESEARCH_EVIDENCE', 'current-run').compatible).toBe(true)
  })
  it('provides generic current-run evidence guidance for Metro', () => {
    insertSource({ id: 48, url: 'https://epiceries.ca/api?endpoint=search&q=lait&store=metro&limit=5', contentType: 'application/json', runId: 'current-run' })
    state.db?.prepare("UPDATE hermes_research_sources SET content_excerpt=? WHERE id=48").run('{"results":[{"name":"Lait","price":2.49,"store":"Metro","updated":"today"}]}')
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='SATISFIED' WHERE ordinal < 10").run()
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='retailer_metro'").run()
    const contract = researchExecutionContract(scope, 'retailer_metro', 'current-run')
    expect(contract).toMatchObject({ requiredActionTypes: ['SAVE_RESEARCH_EVIDENCE'], usefulActionTypes: ['SAVE_RESEARCH_EVIDENCE'], currentRunSourceIds: [48], relevantSourceIds: [48] })
    expect(contract?.knownFacts.join(' ')).toContain('Current retailer requirement: Metro')
    expect(contract?.knownFacts.join(' ')).toContain('Current-run source ID 48')
    expect(contract?.knownFacts.join(' ')).toContain('Claim shape:')
    expect(contract?.knownFacts.join(' ')).toContain('Summary shape:')
  })

  it('supports bounded generic retailer query and evidence guidance for every remaining retailer', () => {
    const retailers = [
      ['retailer_super_c', 'Super C'],
      ['retailer_iga', 'IGA/Sobeys'],
      ['retailer_walmart', 'Walmart Canada'],
      ['retailer_giant_tiger', 'Giant Tiger'],
    ] as const
    for (const [requirementId, name] of retailers) {
      ensureResearchChecklist(scope)
      state.db?.prepare("UPDATE hermes_research_requirements SET status='SATISFIED' WHERE ordinal < (SELECT ordinal FROM hermes_research_requirements WHERE requirement_id=?)").run(requirementId)
      state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id=?").run(requirementId)
      const contract = researchExecutionContract(scope, requirementId, 'current-run')
      expect(contract?.requiredActionTypes).toEqual(['FETCH_PUBLIC_JSON_API'])
      expect(contract?.usefulActionTypes).toEqual(['FETCH_PUBLIC_JSON_API'])
      expect(contract?.knownFacts.join(' ')).toContain('Current retailer requirement: ' + name)
      expect(contract?.knownFacts.join(' ')).toContain('https://epiceries.ca/api?endpoint=search')
      expect(contract?.knownFacts.join(' ')).toContain('limit=20')
      expect(contract?.knownFacts.join(' ')).toContain('supported-store list does not satisfy')
      expect(JSON.stringify(contract)).not.toContain('full source body')
    }
  })

  it('requires retailer evidence to identify observed retailer data from the current-run JSON source', () => {
    insertSource({ id: 46, url: 'https://epiceries.ca/api?endpoint=search&q=lait&store=Maxi&limit=5', contentType: 'application/json', runId: 'current-run' })
    state.db?.prepare("INSERT INTO hermes_research_evidence (tenant_id,workspace_id,project_id,task_id,run_id,source_url,source_title,publisher,claim,evidence_summary,confidence,classification,retrieved_at,source_id,entity) VALUES (1,1,7,14,'current-run','https://epiceries.ca/api?endpoint=search&q=lait&store=Maxi&limit=5','Source','Publisher','The current API response has a store field identifying Maxi product price records.','Observed product and price records include store Maxi.','high','VERIFIED',1,46,'retailer:maxi')").run()
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='SATISFIED' WHERE ordinal < 9").run()
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='retailer_maxi'").run()
    refreshResearchChecklist(scope)
    expect(getResearchChecklistState(scope).find((row) => row.requirement_id === 'retailer_maxi')?.status).toBe('SATISFIED')
  })

  it('exposes a compact execution contract and rejects incompatible sample actions before execution', () => {
    insertEvidence({ url: 'https://epiceries.ca/developers', claim: 'Official API documentation describes the categories endpoint.', entity: 'epiceries.ca' })
    expect(beginNextResearchRequirement(scope, 'run-1')?.id).toBe('epiceries_sample')
    const contract = researchExecutionContract(scope)
    expect(contract).toMatchObject({ requirementId: 'epiceries_sample', requiredActionTypes: ['FETCH_PUBLIC_JSON_API'], usefulActionTypes: ['FETCH_PUBLIC_JSON_API'] })
    expect(contract?.knownFacts).toEqual(expect.arrayContaining(['Official API base: https://epiceries.ca/api', '/api?endpoint=categories']))
    const context = compactResearchContext(scope, 'run-1')
    expect(JSON.stringify(context)).toContain('FETCH_PUBLIC_JSON_API')
    expect(JSON.stringify(context)).toContain('/api?endpoint=categories')
    expect(JSON.stringify(context)).not.toContain('full source body')
    const sourceCount = state.db?.prepare('SELECT COUNT(*) c FROM hermes_research_sources').get()
    expect(researchActionCompatibility(scope, 'FETCH_PUBLIC_URL')).toMatchObject({ compatible: false, code: 'ACTION_NOT_COMPATIBLE_WITH_CURRENT_REQUIREMENT' })
    expect(state.db?.prepare('SELECT COUNT(*) c FROM hermes_research_sources').get()).toEqual(sourceCount)
    expect(researchActionCompatibility(scope, 'FETCH_PUBLIC_JSON_API')).toMatchObject({ compatible: true })
  })

  it('guides epiceries_schema to a current-run JSON refetch and keeps prior sources contextual', () => {
    insertSource({ id: 43, url: 'https://epiceries.ca/api?endpoint=search&q=lait&sort=price_asc&limit=2', contentType: 'application/json', runId: 'prior-run' })
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='SATISFIED' WHERE requirement_id != 'epiceries_schema'").run()
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='epiceries_schema'").run()
    const contract = researchExecutionContract(scope, 'epiceries_schema', 'current-run')
    expect(contract).toMatchObject({ requiredActionTypes: ['FETCH_PUBLIC_JSON_API'], usefulActionTypes: ['FETCH_PUBLIC_JSON_API'], relevantSourceIds: [], priorContextSourceIds: [43] })
    expect(contract?.knownFacts.join(' ')).toContain('Verified JSON API endpoint: https://epiceries.ca/api?endpoint=search&q=lait&sort=price_asc&limit=2')
    expect(contract?.knownFacts.join(' ')).toContain('Prior-run source IDs are context only')
    expect(researchActionCompatibility(scope, 'SAVE_RESEARCH_EVIDENCE', 'current-run').compatible).toBe(false)
  })

  it('allows schema evidence after a successful current-run JSON fetch', () => {
    insertSource({ id: 44, url: 'https://epiceries.ca/api?endpoint=search&q=lait&sort=price_asc&limit=2', contentType: 'application/json', runId: 'current-run' })
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='epiceries_schema'").run()
    const contract = researchExecutionContract(scope, 'epiceries_schema', 'current-run')
    expect(contract).toMatchObject({ requiredActionTypes: [], usefulActionTypes: ['FETCH_PUBLIC_JSON_API', 'SAVE_RESEARCH_EVIDENCE'], relevantSourceIds: [44], currentRunSourceIds: [44] })
    expect(researchActionCompatibility(scope, 'SAVE_RESEARCH_EVIDENCE', 'current-run').compatible).toBe(true)
  })

  it('bounds schema context to field names rather than raw response bodies', () => {
    insertSource({ id: 45, url: 'https://epiceries.ca/api?endpoint=search&q=lait&sort=price_asc&limit=2', contentType: 'application/json', runId: 'prior-run' })
    state.db?.prepare("UPDATE hermes_research_sources SET content_excerpt=? WHERE id=45").run('{"ok":true,"data":{"count":2,"results":[{"id":"x","name":"Lait","price":0.49,"secret":"do-not-expose"}]}}')
    ensureResearchChecklist(scope)
    state.db?.prepare("UPDATE hermes_research_requirements SET status='IN_PROGRESS' WHERE requirement_id='epiceries_schema'").run()
    const context = compactResearchContext(scope, 'current-run')
    const serialized = JSON.stringify(context)
    expect(serialized).toContain('Observed epiceries.ca JSON fields only:')
    expect(serialized).toContain('price')
    expect(serialized).not.toContain('do-not-expose')
  })

  it('does not globally restrict flexible documentation research actions', () => {
    ensureResearchChecklist(scope)
    expect(researchActionCompatibility(scope, 'FETCH_PUBLIC_URL')).toMatchObject({ compatible: true })
    expect(researchActionCompatibility(scope, 'SEARCH_WEB')).toMatchObject({ compatible: true })
  })
})
