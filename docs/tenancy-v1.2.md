# Blueprint v1.2 tenancy foundation

This slice establishes tenant identity and authorization; it does not yet
implement model profiles, memory, backups, finance, or RAG.

## Data model

`tenants` is the platform tenant table. Existing rows retain their numeric
primary key and now receive a stable opaque `tenant_key` (`tnt_` plus a
deterministic SHA-256-derived value), alongside `slug`, `display_name`,
`status`, `created_at`, and `updated_at`. Display names and slugs are labels,
never authorization identifiers.

`tenant_memberships` maps users to tenants with `owner`, `admin`, `operator`,
or `viewer` membership roles. Migration 056 maps each existing user to the
tenant owning their current workspace. The existing local `hermes` admin is
the initial tenant owner. No additional tenants or demo records are created.

## Context lifecycle

Authentication establishes the active tenant from the session's tenant
context. `GET /api/tenants` returns only memberships for the authenticated
user. `POST /api/tenants` accepts an opaque tenant key, verifies membership on
the server, and updates only that user's session and workspace. API keys
cannot switch active tenants. Local storage may cache display state but never
grants access.

Server code should use `resolveTenantContext` or `requireTenantContext` before
tenant-owned reads/writes. Missing, invalid, ambiguous, or unauthorized
context fails closed. Cross-tenant project/workspace helpers remain available
in `src/lib/workspaces.ts`; future tenant-owned repositories must require the
resolved context rather than interpolating client-provided IDs.

## Resource classification

Platform/global resources include Mission Control version, host health, the
global allowed provider/model catalog, and platform security configuration.
Tenant resources include projects, agents, tasks, memory, handoffs, activity,
audit, approvals, notifications, integrations, credential references, model
profiles, usage/costs, finance, and backup policy. Existing workspace-backed
hub routes remain compatibility surfaces while the next slices migrate them
behind tenant repositories.

Tenant authorization decisions are recorded in bounded
`tenant_authorization_audit` rows containing actor, requested/effective tenant
keys, operation class, decision, reason code, and timestamp. Secrets,
passwords, tokens, session values, and sensitive payloads are excluded.
