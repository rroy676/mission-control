import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { classifyHermesRunOutcome, isHermesRunStartEligible, normalizeHermesTaskResultIdentity, resolveHermesBackgroundState, resolveHermesContinuationTokenUsage, shouldFinalizeHermesContinuation, updateHermesTaskStatus } from '@/lib/hermes-background'

function fixture() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, status TEXT NOT NULL,
    updated_at INTEGER NOT NULL, completed_at INTEGER, resolution TEXT, outcome TEXT
  )`)
  db.prepare('INSERT INTO tasks (id, workspace_id, status, updated_at) VALUES (1, 1, \'in_progress\', 10)').run()
  return db
}

describe('Hermes autonomous task completion timestamps', () => {
  it('sets completed_at once for done and preserves it across idempotent completion', () => {
    const db = fixture()
    updateHermesTaskStatus(db, 1, 1, 'done', 'first result', 100)
    updateHermesTaskStatus(db, 1, 1, 'done', 'same result', 200)
    expect(db.prepare('SELECT status, updated_at, completed_at, resolution, outcome FROM tasks WHERE id = 1').get()).toEqual({
      status: 'done', updated_at: 200, completed_at: 100, resolution: 'same result', outcome: 'success',
    })
    db.close()
  })

  it('does not set completed_at for failed tasks and preserves it when requeued', () => {
    const db = fixture()
    updateHermesTaskStatus(db, 1, 1, 'failed', undefined, 100)
    expect(db.prepare('SELECT completed_at FROM tasks WHERE id = 1').get()).toEqual({ completed_at: null })
    updateHermesTaskStatus(db, 1, 1, 'done', 'completed', 200)
    updateHermesTaskStatus(db, 1, 1, 'assigned', undefined, 300)
    expect(db.prepare('SELECT status, completed_at FROM tasks WHERE id = 1').get()).toEqual({ status: 'assigned', completed_at: 200 })
    db.close()
  })
})

describe('Hermes bound task-result identity', () => {
  it.each([
    ['omitted', {}, false],
    ['correct', { task_id: 14 }, false],
    ['foreign tenant', { task_id: 201 }, true],
    ['foreign project', { task_id: 302 }, true],
    ['nonexistent', { task_id: 999999 }, true],
    ['current Task 14 mismatch', { task_id: 'task-14' }, true],
  ])('normalizes %s to the bound task without redirecting mutation', (_label, parameters, mismatch) => {
    expect(normalizeHermesTaskResultIdentity(parameters, 14)).toMatchObject({ taskId: 14, mismatch })
  })

  it('returns the supplied mismatched identifier only as bounded audit data', () => {
    expect(normalizeHermesTaskResultIdentity({ task_id: 'foreign-task' }, 14)).toEqual({
      taskId: 14, mismatch: true, suppliedTaskId: 'foreign-task',
    })
  })

  it('updates only the canonical bound task after normalization', () => {
    const db = fixture()
    db.prepare('INSERT INTO tasks (id, workspace_id, status, updated_at) VALUES (2, 1, \'in_progress\', 10)').run()
    const identity = normalizeHermesTaskResultIdentity({ task_id: 2 }, 1)
    updateHermesTaskStatus(db, identity.taskId, 1, 'review', 'bound result', 100)
    expect(db.prepare('SELECT id, status, resolution FROM tasks ORDER BY id').all()).toEqual([
      { id: 1, status: 'review', resolution: 'bound result' },
      { id: 2, status: 'in_progress', resolution: null },
    ])
    db.close()
  })
})

describe('Hermes COO current-state precedence', () => {
  it('returns IDLE after a failed attempt is superseded by a successful retry', () => {
    expect(resolveHermesBackgroundState({
      paused: false,
      activeStatus: null,
      hasCurrentFailure: false,
      hasCurrentBlock: false,
    })).toBe('IDLE')
    // The failed run remains available in recent history; only the current
    // failure signal is cleared by the successful retry.
  })
})

describe('bounded continuation outcome classification', () => {
  const base = { runStatus: 'SUCCEEDED' as const, taskStatus: 'blocked', beforeSources: 1, afterSources: 1, beforeEvidence: 1, afterEvidence: 1, beforeChecklist: 'pending', afterChecklist: 'pending' }
  it('classifies durable source, evidence, or checklist advancement as progress', () => {
    expect(classifyHermesRunOutcome({ ...base, afterSources: 2 })).toBe('PROGRESS')
    expect(classifyHermesRunOutcome({ ...base, afterEvidence: 2 })).toBe('PROGRESS')
    expect(classifyHermesRunOutcome({ ...base, afterChecklist: 'satisfied' })).toBe('PROGRESS')
  })
  it('does not classify a research claim as progress', () => {
    const before = JSON.stringify([{ requirement_id: 'r1', status: 'PENDING', claimed_by_run_id: null, claimed_at: null }])
    const after = JSON.stringify([{ requirement_id: 'r1', status: 'IN_PROGRESS', claimed_by_run_id: 'run-1', claimed_at: 123 }])
    expect(classifyHermesRunOutcome({ ...base, beforeChecklist: before, afterChecklist: after })).toBe('NO_PROGRESS')
  })
  it('does not classify checklist recovery as progress', () => {
    const before = JSON.stringify([{ requirement_id: 'r1', status: 'IN_PROGRESS' }])
    const after = JSON.stringify([{ requirement_id: 'r1', status: 'PENDING' }])
    expect(classifyHermesRunOutcome({ ...base, beforeChecklist: before, afterChecklist: after })).toBe('NO_PROGRESS')
  })
  it('classifies safely rejected research evidence as no progress', () => {
    expect(classifyHermesRunOutcome({ ...base, runStatus: 'FAILED', error: 'Evidence is invalid: substantive claim and summary are required' })).toBe('NO_PROGRESS')
  })
  it('distinguishes provider/system failure from research no progress', () => {
    expect(classifyHermesRunOutcome({ ...base, runStatus: 'FAILED', error: 'OpenRouter unavailable' })).toBe('SYSTEM_ERROR')
    expect(classifyHermesRunOutcome({ ...base, runStatus: 'INTERRUPTED', error: 'Mission Control is PAUSED' })).toBe('RESEARCH_BLOCKED')
  })
  it('classifies CEO, review, and completion boundaries from durable state', () => {
    expect(classifyHermesRunOutcome({ ...base, runStatus: 'WAITING_FOR_CEO', taskStatus: 'awaiting_owner' })).toBe('WAITING_CEO')
    expect(classifyHermesRunOutcome({ ...base, taskStatus: 'review' })).toBe('COMPLETE_OR_REVIEW')
    expect(classifyHermesRunOutcome({ ...base, taskStatus: 'done' })).toBe('COMPLETE_OR_REVIEW')
  })
  it('does not let a model error string override durable progress', () => {
    expect(classifyHermesRunOutcome({ ...base, afterEvidence: 2, error: 'provider error' })).toBe('PROGRESS')
  })
})


describe('Hermes continuation final start gate', () => {
  const base = {
    taskExists: true, taskStatus: 'in_progress', autonomous: true, paused: false, activeRun: false,
    continuationExists: true, continuationEnabled: true, continuationState: 'RUNNING', leaseOwned: true,
    leaseUntil: 200, nextRunAt: 100, scheduled: true, timestamp: 100,
  }

  it.each([
    ['disable committed after scheduler selection', { continuationEnabled: false }],
    ['next run cleared by disable', { nextRunAt: null }],
    ['lease cleared by disable', { leaseOwned: false }],
    ['lease expired', { leaseUntil: 99 }],
    ['continuation deleted', { continuationExists: false }],
    ['task deleted', { taskExists: false }],
    ['task no longer autonomous', { autonomous: false }],
    ['task no longer runnable', { taskStatus: 'blocked' }],
    ['global pause', { paused: true }],
    ['active run exists', { activeRun: true }],
    ['continuation is not in running lease state', { continuationState: 'READY' }],
    ['scheduled run is not due', { nextRunAt: 101 }],
  ])('rejects %s immediately before run creation', (_label, change) => {
    expect(isHermesRunStartEligible({ ...base, ...change })).toBe(false)
  })

  it('accepts a normal enabled due continuation with its owned valid lease', () => {
    expect(isHermesRunStartEligible(base)).toBe(true)
  })

  it('allows CONTINUE ONCE-style starts without a scheduled continuation lease', () => {
    expect(isHermesRunStartEligible({ ...base, scheduled: false, continuationExists: false, continuationEnabled: false, continuationState: null, leaseOwned: false, leaseUntil: null, nextRunAt: null })).toBe(true)
  })
})


describe('Hermes continuation token accounting primitives', () => {
  it('uses persisted totals when finalizer arguments are zero', () => {
    expect(resolveHermesContinuationTokenUsage(0, 0, 120, 30)).toEqual({ inputTokens: 120, outputTokens: 30 })
  })
  it('uses response totals when present for successful progress', () => {
    expect(resolveHermesContinuationTokenUsage(90, 20, 120, 30)).toEqual({ inputTokens: 90, outputTokens: 20 })
  })
  it('counts repaired failures and provider failures from persisted run totals', () => {
    expect(resolveHermesContinuationTokenUsage(0, 0, 40, 8)).toEqual({ inputTokens: 40, outputTokens: 8 })
    expect(resolveHermesContinuationTokenUsage(0, 0, 11, 4)).toEqual({ inputTokens: 11, outputTokens: 4 })
  })
  it('counts disabled-during-active finalization using persisted totals', () => {
    expect(resolveHermesContinuationTokenUsage(0, 0, 70, 9)).toEqual({ inputTokens: 70, outputTokens: 9 })
  })
  it('does not double count an already finalized run', () => {
    expect(shouldFinalizeHermesContinuation('run-1', 'run-1')).toBe(false)
    expect(shouldFinalizeHermesContinuation('run-0', 'run-1')).toBe(true)
  })
  it('keeps unavailable token usage at zero', () => {
    expect(resolveHermesContinuationTokenUsage(0, 0, 0, 0)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
  it('preserves budget inputs for failed runs instead of replacing them with zero', () => {
    const current = { cumulative_input_tokens: 99_950, cumulative_output_tokens: 11_990 }
    const usage = resolveHermesContinuationTokenUsage(0, 0, 75, 20)
    expect(current.cumulative_input_tokens + usage.inputTokens).toBeGreaterThan(100_000)
    expect(current.cumulative_output_tokens + usage.outputTokens).toBeGreaterThan(12_000)
  })
})
