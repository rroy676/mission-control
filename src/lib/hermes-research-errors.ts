export class HermesResearchParameterError extends Error {
  readonly researchRepairable = true
  readonly category = 'REPAIRABLE_PARAMETER_ERROR' as const

  constructor(message: string) {
    super(message)
    this.name = 'HermesResearchParameterError'
  }
}
