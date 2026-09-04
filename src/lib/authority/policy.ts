import type { AuthorityDecision, DispatchMode, PauseAction } from './types'

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/
const MAX_REASON = 500

function deny(code: string, reason: string, requestId: string | null = null, mode: DispatchMode | 'UNKNOWN' = 'UNKNOWN'): AuthorityDecision {
  return { verdict: 'deny', reason_code: code, reason, request_id: requestId, mode }
}

export function parsePauseAction(input: unknown): { action?: PauseAction; decision?: AuthorityDecision } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { decision: deny('MALFORMED_REQUEST', 'request must be an object') }
  const value = input as Record<string, unknown>
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'action,reason,request_id,requested_by') return { decision: deny('UNKNOWN_FIELD', 'only the typed pause fields are accepted', typeof value.request_id === 'string' ? value.request_id : null) }
  if (value.action !== 'pause') return { decision: deny('UNSUPPORTED_ACTION', 'only action=pause is supported', typeof value.request_id === 'string' ? value.request_id : null) }
  if (value.requested_by !== 'CEO') return { decision: deny('UNAUTHORIZED_REQUESTER', 'requester must be CEO', typeof value.request_id === 'string' ? value.request_id : null) }
  if (typeof value.reason !== 'string' || value.reason.trim().length < 1 || value.reason.length > MAX_REASON) return { decision: deny('INVALID_REASON', 'reason must be 1-500 characters', typeof value.request_id === 'string' ? value.request_id : null) }
  if (typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id)) return { decision: deny('INVALID_REQUEST_ID', 'request_id format is invalid', typeof value.request_id === 'string' ? value.request_id : null) }
  return { action: { action: 'pause', requested_by: 'CEO', reason: value.reason.trim(), request_id: value.request_id } }
}

export function evaluatePause(input: unknown, currentMode: DispatchMode | 'UNKNOWN' = 'UNKNOWN'): AuthorityDecision {
  const parsed = parsePauseAction(input)
  if (parsed.decision) return { ...parsed.decision, mode: currentMode }
  return { verdict: 'allow', reason_code: currentMode === 'PAUSED' ? 'ALREADY_PAUSED' : 'PAUSE_ALLOWED', reason: currentMode === 'PAUSED' ? 'dispatch is already PAUSED; request is idempotently allowed' : 'typed CEO PAUSE is allowed', request_id: parsed.action!.request_id, mode: currentMode }
}
