import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { resolveHermesBackgroundState, updateHermesTaskStatus } from '@/lib/hermes-background'

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
