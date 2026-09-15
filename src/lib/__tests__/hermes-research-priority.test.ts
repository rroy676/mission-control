import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Database.Database | null, audit: vi.fn() }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  logAuditEvent: state.audit,
}))

import { beginNextResearchRequirement, compactResearchContext, ensureResearchChecklist, getResearchChecklistState, recoverStaleResearchClaims, refreshResearchChecklist } from '@/lib/hermes-research'

const scope = { tenantId: 1, workspaceId: 1, projectId: 7, taskId: 14 }

function insertEvidence(input: { tenantId?: number; url: string; claim: string; summary?: string; entity?: string }) {
  state.db?.prepare(`INSERT OR IGNORE INTO hermes_research_sources
    (id,tenant_id,workspace_id,project_id,task_id,run_id,url,content_type,http_status,fetch_outcome)
    VALUES (1,?,?,?,?,?,'https://epiceries.ca/developers','text/html',200,'SUCCESS')`).run(input.tenantId ?? 1, 1, 7, 14, 'run-1')
  state.db?.prepare(`INSERT INTO hermes_research_evidence
    (tenant_id,workspace_id,project_id,task_id,run_id,source_url,source_title,publisher,claim,evidence_summary,confidence,classification,retrieved_at,source_id,entity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.tenantId ?? 1, 1, 7, 14, 'run-1', input.url, 'Source', 'Publisher', input.claim, input.summary || 'Summary', 'high', 'VERIFIED', 1, 1, input.entity || null)
}

function insertSource(input: { id: number; url: string; contentType?: string; runId?: string }) {
  state.db?.prepare(`INSERT INTO hermes_research_sources
    (id,tenant_id,workspace_id,project_id,task_id,run_id,url,content_type,http_status,fetch_outcome)
    VALUES (?,?,?,?,?,?,?,?,200,'SUCCESS')`).run(input.id, 1, 1, 7, 14, input.runId || 'run-1', input.url, input.contentType || 'text/html')
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
        run_id TEXT, url TEXT, content_type TEXT, http_status INTEGER, fetch_outcome TEXT
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
    insertEvidence({ url: 'https://epiceries.ca/developers', claim: 'Official API documentation describes an endpoint and response fields.', entity: 'epiceries.ca' })
    expect(beginNextResearchRequirement(scope, 'run-1')?.id).toBe('epiceries_sample')
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
})
