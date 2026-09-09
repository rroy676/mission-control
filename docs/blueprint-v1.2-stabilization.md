# Blueprint v1.2 stabilization findings

Date: 2026-09-08

## Test timeouts

The five accepted broad-suite timeout failures were:

- `src/lib/__tests__/password.test.ts` — `verifyPassword > is case-sensitive`
- `src/lib/__tests__/security-scan-gateway-auth.test.ts` — `does not crash and passes when token is a SecretRef object`
- all three tests in `src/integration/ephemeral-two-tenant-http.test.ts`

The password test performs three production-cost scrypt verifications. The gateway-auth scan test is CPU-sensitive when expensive password tests run concurrently. The HTTP tests start a real Next child server and execute many authenticated requests; isolated runs took 10.6s, 12.1s, and 14.5s. The harness already uses generated `/tmp` state, random ports, active readiness polling, isolated environment variables, seeded tenant-scoped SQLite data, and unconditional teardown. Isolation found no port collision, tenant leakage, SQLite lifecycle issue, readiness race, scheduler interference, or leaked child process.

Timeouts are suite-local: 15 seconds for password/security-scan suites and 60 seconds for the ephemeral HTTP suite. Production hashing remains scrypt `N=65536`; the HTTP fixture’s explicit `N=16384` legacy format is test data only.

## ESLint

The heap failure came from `eslint .` traversing the generated `.next` directory, approximately 961 MB across 4,317 files. `.next` and `.data-test` are explicit ignores, and the lint entrypoint now targets source, scripts, and JavaScript/TypeScript project configuration files. No oversized heap allocation is required.

## Gateway state

The deployment sets `NEXT_PUBLIC_GATEWAY_OPTIONAL=true`; OpenClaw is intentionally absent and no gateway is required by Blueprint v1.2. Gateway status now distinguishes `OPTIONAL`, `NOT_CONFIGURED`, `OFFLINE`, and `ONLINE`. Optional absence no longer makes the overall control-plane health unhealthy. Explicit gateway configuration still supports future legitimate gateway connectivity.
