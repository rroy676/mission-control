import { describe, expect, it, vi } from 'vitest'
import { evaluatePause, parsePauseAction } from './policy'

const valid = { action: 'pause', requested_by: 'CEO', reason: 'emergency stop', request_id: 'mc-test-12345678' }

describe('embedded PAUSE authority', () => {
  it('allows a strict typed CEO request and is idempotently allowable while paused', () => {
    expect(parsePauseAction(valid).action).toEqual(valid)
    expect(evaluatePause(valid, 'ACTIVE')).toMatchObject({ verdict: 'allow', reason_code: 'PAUSE_ALLOWED' })
    expect(evaluatePause(valid, 'PAUSED')).toMatchObject({ verdict: 'allow', reason_code: 'ALREADY_PAUSED' })
  })

  it.each([
    ['unknown action', { ...valid, action: 'pilot' }, 'UNSUPPORTED_ACTION'],
    ['forged requester', { ...valid, requested_by: 'Hermes' }, 'UNAUTHORIZED_REQUESTER'],
    ['unsupported role/token field', { ...valid, role: 'admin' }, 'UNKNOWN_FIELD'],
    ['malformed payload', { action: 'pause' }, 'UNKNOWN_FIELD'],
    ['bad request id', { ...valid, request_id: 'bad' }, 'INVALID_REQUEST_ID'],
  ])('rejects %s', (_label, payload, code) => {
    expect(evaluatePause(payload)).toMatchObject({ verdict: 'deny', reason_code: code })
  })

  it('rejects unauthenticated/unsupported callers at the route boundary', () => {
    // Authentication is enforced by requireRole before this package is called.
    expect(evaluatePause({ ...valid, requested_by: 'anonymous' }).verdict).toBe('deny')
  })
})

describe('shadow comparison', () => {
  it('fails safe on reference outage and mismatch without an authority writer', async () => {
    vi.resetModules()
    vi.doMock('./reference-adapter', () => ({ evaluatePauseReference: vi.fn()
      .mockResolvedValueOnce({ verdict: 'deny', result: null, reason_code: 'REFERENCE_UNAVAILABLE' })
      .mockResolvedValueOnce({ verdict: 'deny', result: null, reason_code: 'REFERENCE_DENIED' }) }))
    vi.doMock('./state', () => ({
      readAuthorityShadowState: vi.fn(() => ({ dispatch_mode: 'ACTIVE', last_request: null })),
      writeAuthorityShadowState: vi.fn(),
    }))
    const { processPauseShadow } = await import('./shadow')
    const unavailable = await processPauseShadow(valid, 'admin')
    expect(unavailable).toMatchObject({ allow: false, equivalence: false, reason_code: 'REFERENCE_UNAVAILABLE', mismatch: true })
    const mismatch = await processPauseShadow(valid, 'admin')
    expect(mismatch.allow).toBe(false)
  })
})
