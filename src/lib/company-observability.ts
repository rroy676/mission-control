import fs from 'node:fs'
import path from 'node:path'

const STATUS_PATH = '/home/hermes/projects/autonomous-company/operations/mission-control-status.json'

export type CompanyObservability = {
  schema_version: number
  generated_at: string
  company: Record<string, unknown>
  engineering: Record<string, unknown>
  blueprint: Record<string, string>
  product_ops: Record<string, unknown>
  backup_dr: Record<string, unknown>
  finance: Record<string, unknown>
  memory: Record<string, unknown>
  projects: Array<Record<string, unknown>>
  agents: Array<Record<string, unknown>>
  policy: { mode: string; generated_by: string }
}

export function readCompanyObservability(): CompanyObservability {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as CompanyObservability
    if (parsed?.schema_version !== 1 || parsed?.policy?.mode !== 'observability-only') throw new Error('invalid status schema')
    return parsed
  } catch {
    return {
      schema_version: 1, generated_at: '', company: {}, engineering: {}, blueprint: {},
      product_ops: {}, backup_dr: {}, finance: {}, memory: {}, projects: [], agents: [],
      policy: { mode: 'observability-only', generated_by: 'autonomous-company' },
    }
  }
}
