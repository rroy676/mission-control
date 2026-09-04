import type { PauseAction } from './types'

const CONTROL_URL = process.env.MISSION_CONTROL_REFERENCE_CONTROL_URL || 'http://127.0.0.1:8765/api/control'
const SECRET = process.env.MISSION_CONTROL_CONTROL_SECRET || process.env.API_KEY || ''

export async function evaluatePauseReference(request: PauseAction | unknown): Promise<{ verdict: 'allow' | 'deny'; result: Record<string, unknown> | null; reason_code: string }> {
  if (!SECRET) return { verdict: 'deny', result: null, reason_code: 'REFERENCE_UNAVAILABLE' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(CONTROL_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mission-control-control-secret': SECRET }, body: JSON.stringify(request), cache: 'no-store', signal: controller.signal })
    const body = await response.json().catch(() => null)
    const result = body && typeof body === 'object' ? body as Record<string, unknown> : null
    return { verdict: response.ok && result?.ok === true ? 'allow' : 'deny', result, reason_code: response.ok && result?.ok === true ? 'REFERENCE_ALLOWED' : 'REFERENCE_DENIED' }
  } catch { return { verdict: 'deny', result: null, reason_code: 'REFERENCE_UNAVAILABLE' } }
  finally { clearTimeout(timer) }
}
