import { evaluatePause, parsePauseAction } from './policy'
import { evaluatePauseReference } from './reference-adapter'
import { readAuthorityShadowState, writeAuthorityShadowState } from './state'
import type { ShadowComparison } from './types'

export async function processPauseShadow(input: unknown, requester: string): Promise<ShadowComparison> {
  const state = readAuthorityShadowState()
  const embedded = evaluatePause(input, state.dispatch_mode === 'PAUSED' || state.dispatch_mode === 'PILOT' || state.dispatch_mode === 'ACTIVE' ? state.dispatch_mode : 'UNKNOWN')
  const parsed = parsePauseAction(input)
  const reference = await evaluatePauseReference(parsed.action || input)
  const requestId = embedded.request_id
  const equivalence = embedded.verdict === reference.verdict
  const comparison: ShadowComparison = {
    timestamp: new Date().toISOString(), request_id: requestId, requester, action: parsed.action?.action || null,
    allow: equivalence && embedded.verdict === 'allow', embedded_verdict: embedded.verdict, reference_verdict: reference.verdict,
    equivalence, reason_code: equivalence ? embedded.reason_code : reference.reason_code === 'REFERENCE_UNAVAILABLE' ? 'REFERENCE_UNAVAILABLE' : 'AUTHORITY_MISMATCH', mismatch: !equivalence,
    authoritative_result: equivalence && reference.verdict === 'allow' ? reference.result : null,
  }
  writeAuthorityShadowState({ dispatch_mode: comparison.authoritative_result?.mode === 'PAUSED' ? 'PAUSED' : state.dispatch_mode, last_request: comparison })
  return comparison
}
