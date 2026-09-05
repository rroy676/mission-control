# Portable tenant working memory

Mission Control working memory is a bounded structured store, independent of
the native OpenClaw filesystem memory browser. Each record has a stable
`mem_<UUID>` identifier, `schema_version: "1.0"`, stable tenant key, optional
project/agent/task references, a closed memory-type enum, explicit scope,
bounded content and typed metadata, lifecycle and promotion status, timestamps,
and an optional durable reference. JSON serialization is suitable for the
future `memory.jsonl` tenant export and does not require SQLite row IDs.

The supported types are `current_state`, `handoff`, `task_outcome`,
`recent_decision`, `incident_context`, `product_context`, `operational_note`,
`blocker`, `lesson_candidate`, and `promotion_candidate`. Scopes are
`tenant/company`, `project`, `agent`, and `task`. Lifecycle values are active,
superseded, resolved, expired, and archived.

All API operations resolve `requireTenantContext` from authenticated membership
and the active session tenant. Tenant filtering is the first SQL predicate;
project, agent, task, model-profile, and handoff references are verified in the
same tenant. Cross-tenant and forged context fail closed and are audit-recorded.
Reads are deterministic (`updated_at DESC, memory_id ASC`) and capped at 100.
Current-state creation supersedes the prior active state for the same tenant or
project while retaining history.

Handoffs are typed working-memory records with source/destination agents,
objective, context, constraints, references, expected result, status, and
completion time. They carry context only; they are not authorization and cannot
contain credentials or authority tokens. Model profile IDs may be recorded only
after same-tenant validation; model resolution remains the model-profile
resolver's responsibility.

Significance classification is deterministic: transient, retain-working, or
promotion-candidate. Material decisions, incidents, lessons, strategy,
architecture, governance, acceptance evidence, and material current-state
changes become candidates for review; ordinary prose does not automatically
become a durable CEO decision. Durable promotion is a later slice.

Creation, update, handoff, completion, promotion-candidate, validation/security
rejection, and cross-tenant denial events belong in tenant-scoped Activity/Audit.
Ordinary reads do not flood Activity. Secret-like fields and values are rejected;
raw credentials are never stored. The pre-existing OpenClaw file browser remains
available for native memory infrastructure, but it is not used as this portable
tenant record store.

## Durable promotion and tenant export

Promotion is explicit and bounded. Owner/admin users may promote eligible
incident, lesson, current-state, product-state, decision, governance,
architecture, acceptance, Finance, or Growth material through
`POST /api/memory/working/:id/promotion`. Candidate status is only a review
signal; it does not write the archive. CEO decision promotion requires the
tenant owner. Viewers cannot promote or reject, and operators cannot promote.

The server resolves tenant membership and the active session tenant before
loading the memory. A foreign memory, project, agent, model profile, or
tenant key is denied. Promotion writes a versioned Markdown note below the
existing `Software-Studio` archive, in a policy-derived tenant namespace,
then stages only that note and commits only that path. The durable linkage
(`durable_id`, path, promotion type, actor, timestamp, and commit SHA) is
stored back on the working-memory record and in tenant-scoped audit history.
Repeated promotion is idempotent. Changed content requires a future explicit
supersession operation; institutional history is not silently overwritten.

Promotion Markdown uses `durable-memory-1.0` front matter and excludes
passwords, tokens, cookies, API keys, private keys, and runtime secret blobs.

`POST /api/tenant-export` creates a local protected `.tar.gz` bundle for the
effective tenant. The bundle contains `manifest.json`, deterministic JSON or
JSONL payload files, tenant-filtered promoted Markdown under
`durable-memory/`, and SHA-256 `checksums.txt`. Exports are not encrypted or
uploaded in this slice. Admin users create/download exports; viewers may
inspect status. The validator checks archive traversal, root structure,
manifest, checksums, and secret policy before a completed export is returned.
No restore or cloud-backup provider is implemented.
