import { randomUUID } from 'crypto'
import { z } from 'zod'

export const MEMORY_SCHEMA_VERSION = '1.0'
export const memoryTypes = ['current_state','handoff','task_outcome','recent_decision','incident_context','product_context','operational_note','blocker','lesson_candidate','promotion_candidate'] as const
export const memoryScopes = ['tenant/company','project','agent','task'] as const
export const importanceValues = ['low','normal','high','critical'] as const
export const lifecycleValues = ['active','superseded','resolved','expired','archived'] as const
export const promotionValues = ['none','promotion-candidate','promoted'] as const
export type MemoryType = typeof memoryTypes[number]
export type MemoryScope = typeof memoryScopes[number]

const scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()])
const boundedMetadata = z.record(z.string().max(80), scalar).refine((v) => Object.keys(v).length <= 40, 'metadata has too many fields')

export const portableMemorySchema = z.object({
  memory_id: z.string().regex(/^mem_[a-f0-9-]{20,80}$/), schema_version: z.literal(MEMORY_SCHEMA_VERSION),
  tenant_id: z.string().min(1).max(160), project_id: z.string().min(1).max(160).nullable().optional(),
  agent_id: z.string().min(1).max(160).nullable().optional(), task_id: z.string().min(1).max(160).nullable().optional(),
  memory_type: z.enum(memoryTypes), scope: z.enum(memoryScopes), title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(20_000), source: z.string().trim().min(1).max(240),
  importance: z.enum(importanceValues), lifecycle_status: z.enum(lifecycleValues), promotion_status: z.enum(promotionValues),
  durable_reference: z.string().max(500).nullable().optional(), created_at: z.number().int().positive(), updated_at: z.number().int().positive(),
  expires_at: z.number().int().positive().nullable().optional(), metadata: boundedMetadata.default({}),
}).strict()
export type PortableMemory = z.infer<typeof portableMemorySchema>

export function newMemoryId(): string { return `mem_${randomUUID()}` }

const secretPattern = /(api[_ -]?key|password|passwd|session[_ -]?cookie|bearer\s+token|access[_ -]?token|secret|encryption[_ -]?key|private[_ -]?key)\s*["']?\s*[:=]/i
const bearerValuePattern = /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i
const privateKeyMarkerPattern = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i
export function rejectSecrets(value: unknown): void {
  const text = JSON.stringify(value)
  if (secretPattern.test(text) || bearerValuePattern.test(text) || privateKeyMarkerPattern.test(text) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)) throw new Error('Memory payload contains a secret-like field or value')
}

export function classifySignificance(input: { memory_type: MemoryType; importance?: PortableMemory['importance']; title?: string; content?: string }): 'transient' | 'retain-working' | 'promotion-candidate' {
  if (input.memory_type === 'promotion_candidate' || input.memory_type === 'recent_decision' || input.memory_type === 'incident_context' || input.memory_type === 'lesson_candidate') return 'promotion-candidate'
  const text = `${input.title || ''} ${input.content || ''}`.toLowerCase()
  if (input.memory_type === 'current_state' && (input.importance === 'high' || input.importance === 'critical')) return 'promotion-candidate'
  if (input.importance === 'critical' || /\b(ceo decision|governance|architecture change|product strategy|acceptance evidence|finance decision)\b/.test(text)) return 'promotion-candidate'
  if (input.memory_type === 'operational_note' && input.importance === 'low') return 'transient'
  return 'retain-working'
}

export function serializeMemory(record: PortableMemory): string { return JSON.stringify(portableMemorySchema.parse(record)) }
export function deserializeMemory(serialized: string): PortableMemory { return portableMemorySchema.parse(JSON.parse(serialized)) }
