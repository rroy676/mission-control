import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { classifyHermesRunOutcome, normalizeHermesTaskResultIdentity, resolveHermesBackgroundState, updateHermesTaskStatus } from '@/lib/hermes-background'

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
