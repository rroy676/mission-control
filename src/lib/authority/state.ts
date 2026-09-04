import fs from 'node:fs'
import path from 'node:path'
import { config } from '@/lib/config'
import type { ShadowComparison } from './types'

export type AuthorityShadowState = { dispatch_mode: string; last_request: ShadowComparison | null }
const STATE_PATH = path.join(config.dataDir, 'authority-shadow-state.json')

export function readAuthorityShadowState(): AuthorityShadowState {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as AuthorityShadowState
    if (!state || typeof state !== 'object') throw new Error('invalid state')
    return { dispatch_mode: typeof state.dispatch_mode === 'string' ? state.dispatch_mode : 'UNKNOWN', last_request: state.last_request || null }
  } catch { return { dispatch_mode: 'UNKNOWN', last_request: null } }
}

export function writeAuthorityShadowState(state: AuthorityShadowState): void {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const temp = `${STATE_PATH}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temp, STATE_PATH)
}
