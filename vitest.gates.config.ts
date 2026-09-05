import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const gate = process.env.VITEST_GATE || 'core'
const integration = [
  'src/integration/ephemeral-two-tenant-http.test.ts',
  'src/lib/__tests__/gnap-sync.test.ts',
  'src/lib/__tests__/security-scan-gateway-auth.test.ts',
]
const slow = [
  'src/lib/__tests__/password.test.ts',
  'src/lib/__tests__/security-scan-auth-password.test.ts',
]
const core = [
  'src/app/api/auth/logout/route.test.ts',
  'src/app/api/memory/working/route.test.ts',
  'src/lib/__tests__/api-contract-parity.test.ts',
  'src/lib/__tests__/auth.test.ts',
  'src/lib/__tests__/portable-memory.test.ts',
  'src/lib/__tests__/model-profiles.test.ts',
  'src/lib/__tests__/working-memory-isolation.test.ts',
  'src/lib/__tests__/tenant-context.test.ts',
  'src/lib/__tests__/workspaces-tenant-access.test.ts',
  'src/lib/__tests__/security-events.test.ts',
  'src/lib/__tests__/security-properties.test.ts',
  'src/lib/__tests__/security-scan-portability.test.ts',
  'src/lib/__tests__/security-scan-backup.test.ts',
  'src/lib/__tests__/hermes-route-security.test.ts',
  'src/lib/__tests__/agent-memory-route-security.test.ts',
  'src/lib/__tests__/task-route-security.test.ts',
  'src/lib/__tests__/skills-route-security.test.ts',
  'src/lib/__tests__/gateway-control-route-security.test.ts',
  'src/lib/__tests__/gateway-config-route-security.test.ts',
  'src/lib/__tests__/backup-route-security.test.ts',
]

function quoted(paths: string[]) {
  return paths.map((path) => `**/${path.replace(/^src\//, '')}`)
}

export default defineConfig(async () => {
  const { default: tsconfigPaths } = await import('vite-tsconfig-paths')
  const excludes = gate === 'integration'
    ? ['**/node_modules/**', ...quoted(slow)]
    : gate === 'slow'
      ? ['**/node_modules/**', ...quoted(integration)]
      : ['**/node_modules/**', ...quoted(integration), ...quoted(slow)]
  const include = gate === 'integration'
    ? integration
    : gate === 'slow'
      ? slow
    : core

  return {
    plugins: [react(), tsconfigPaths()],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['src/test/setup.ts'],
      include,
      exclude: excludes,
      hookTimeout: gate === 'integration' ? 60_000 : 15_000,
      testTimeout: gate === 'integration' ? 45_000 : gate === 'slow' ? 60_000 : 15_000,
      pool: 'forks' as const,
      maxWorkers: 2,
      minWorkers: 1,
    },
  }
})
