export type DispatchMode = 'PAUSED' | 'PILOT' | 'ACTIVE'
export type AuthorityVerdict = 'allow' | 'deny'

export type PauseAction = {
  action: 'pause'
  requested_by: 'CEO'
  reason: string
  request_id: string
}

export type AuthorityDecision = {
  verdict: AuthorityVerdict
  reason_code: string
  reason: string
  request_id: string | null
  mode: DispatchMode | 'UNKNOWN'
}

export type ShadowComparison = {
  timestamp: string
  request_id: string | null
  requester: string
  action: string | null
  allow: boolean
  embedded_verdict: AuthorityVerdict
  reference_verdict: AuthorityVerdict
  equivalence: boolean
  reason_code: string
  mismatch: boolean
  authoritative_result: Record<string, unknown> | null
}
