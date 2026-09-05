import { describe, expect, it } from 'vitest'
import { classifySignificance, deserializeMemory, portableMemorySchema, serializeMemory, rejectSecrets } from '@/lib/portable-memory'

const record = { memory_id:'mem_12345678901234567890', schema_version:'1.0' as const, tenant_id:'tnt_alpha', project_id:'project-stationarr', agent_id:null, task_id:null, memory_type:'current_state' as const, scope:'project' as const, title:'Stationarr current state', content:'Validation passed', source:'live-validation', importance:'high' as const, lifecycle_status:'active' as const, promotion_status:'promotion-candidate' as const, durable_reference:null, created_at:1700000000, updated_at:1700000001, expires_at:null, metadata:{ evidence:'bounded' } }

describe('portable working-memory contract', () => {
  it('round-trips without Mission Control internal row ids', () => {
    const restored = deserializeMemory(serializeMemory(record))
    expect(restored).toEqual(record)
    expect(serializeMemory(record)).not.toContain('session_id')
  })
  it('rejects unknown fields and bounded metadata overflow', () => {
    expect(portableMemorySchema.safeParse({ ...record, rowid: 4 }).success).toBe(false)
    expect(portableMemorySchema.safeParse({ ...record, metadata: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, true])) }).success).toBe(false)
  })

  it('rejects secret-like metadata keys after JSON serialization', () => {
    expect(() => rejectSecrets({ metadata: { password: 'fixture' } })).toThrow()
  })
  it('classifies explicit material context for promotion review only', () => {
    expect(classifySignificance({ memory_type:'operational_note', importance:'low' })).toBe('transient')
    expect(classifySignificance({ memory_type:'recent_decision', importance:'normal' })).toBe('promotion-candidate')
    expect(classifySignificance({ memory_type:'operational_note', importance:'normal', content:'ordinary agent prose' })).toBe('retain-working')
  })
  it('rejects secret-like payloads through schema boundary', () => {
    expect(() => rejectSecrets({ content:'password: do-not-store' })).toThrow()
    expect(() => rejectSecrets({ content:'credential_ref: tenant/provider/primary' })).not.toThrow()
  })
})
