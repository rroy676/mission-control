# ADR 0062: Mission Control Hermes runtime adapter

Status: accepted for the runtime-adapter slice

Mission Control selects an agent transport from `agents.runtime_type`. Hermes
uses its supported authenticated HTTP API server; OpenClaw remains a separate,
optional legacy adapter and is not required by Hermes.

## Validated Hermes contract

The installed implementation is `~/.hermes/hermes-agent/gateway/platforms/api_server.py`.
The gateway enables this platform when `API_SERVER_KEY` is a usable secret
(at least 16 characters). `API_SERVER_HOST` defaults to `127.0.0.1`,
`API_SERVER_PORT` defaults to `8642`, and `API_SERVER_ENABLED=true` alone is
not sufficient. The process starts the aiohttp server as the `api_server`
platform during the normal Hermes gateway lifecycle; it is not a second
Hermes process. The installed implementation requires `Authorization: Bearer
<API_SERVER_KEY>` for authenticated routes. `/health` is a simple unauthenticated
probe and returns `{status: "ok", platform: "hermes-agent", version}`.

The synchronous session contract used here is:

1. `POST /api/sessions` with `{id, source, title}` returns `201` and a
   client-safe `hermes.session` object. Repeating the same ID returns `409`.
2. `POST /api/sessions/{session_id}/chat` with `{message}` (and optional
   `system_message`/`instructions`) returns `200` with
   `{object: "hermes.session.chat.completion", session_id, message:
   {role: "assistant", content}, usage, runtime}` and an
   `X-Hermes-Session-Id` header.
3. Missing sessions return `404` with an OpenAI-style error envelope;
   malformed requests return `400`; authentication failures return `401`.

`/v1/chat/completions` is also available and supports optional continuity via
`X-Hermes-Session-Id`, but the persisted session endpoint is preferable here
because it makes session ownership explicit. `/v1/runs` is asynchronous (`202`,
`run_id`, poll/events endpoints) and is reserved for a future bounded COO
action flow. Streaming is optional; this slice uses synchronous responses.

The API server persists session state in Hermes’ SessionDB/state database, so
session IDs are stable across requests and normally survive gateway restart.
Telegram is a separate Hermes platform and can coexist with `api_server`.
The installed API server binds TCP only; no Unix-socket chat protocol is
defined by this implementation. `gateway.sock` is therefore not used.

## Session and security model

`hermes_runtime_bindings` stores the Mission Control tenant, workspace, agent,
optional project, and Hermes session ID. One session is used per tenant,
workspace, agent, and project context. IDs are deterministic and server-created;
the browser cannot select or rebind a foreign session. Project IDs are checked
against the authenticated tenant/workspace before use.

The Hermes API key is read only in server code from `MC_HERMES_API_KEY` or the
Hermes `API_SERVER_KEY` environment variable. It is never persisted in Mission
Control state, returned to clients, or logged. Production configuration must
keep the Hermes API server on loopback/private networking and manage the key
outside Git with mode `0600` when file-backed.

Hermes status is based on the private `/health` probe and is reported as
`AVAILABLE`, `OFFLINE`, `DEGRADED`, or `NOT_CONFIGURED`; OpenClaw session recency
does not determine Hermes availability. The Quebec Grocery Intelligence
acceptance remains pending until its expected knowledge file exists; this ADR
does not fabricate project context.

Future adapters should implement the same server-side selection boundary and
must not add unrestricted RPC, shell, PTY, terminal, or direct database access.
OpenClaw is intentionally absent and OPTIONAL; future agents must not reinstall
it to repair Hermes.

## COO project context and action boundary

Mission Control resolves a selected project from the authenticated user's
tenant/workspace membership. The browser-provided project identifier is only a
lookup hint; it is never trusted as authority. Foreign tenant/workspace or
inactive projects fail closed. Hermes bindings are unique per tenant,
workspace, agent, and project, so switching projects selects a separate
session and cannot retain the prior project's transcript.

For a project-bound turn, MC injects a bounded JSON context containing the
server-resolved project identity, the active current-state memory, up to eight
other active project memories, and (for Quebec Grocery Intelligence) the
allowlisted `knowledge/quebec-grocery-intelligence-master-plan.md` document.
The document is read through the Mission Control knowledge path; Hermes has no
filesystem authority. A missing document is represented as missing and must
not be inferred or recreated.

Hermes may emit only `CREATE_TASK`, `SAVE_WORKING_MEMORY`, or
`REQUEST_CEO_APPROVAL` inside the structured action envelope. MC validates the
action, rechecks the session binding and tenant/project authority, attributes
the write to Hermes, uses the bounded task/memory service, and records both
activity and tenant-scoped audit evidence. CEO approval remains required for
paid licensing, pricing or business-model changes, capital spending, major
legal/privacy risk acceptance, architecture changes, and financial transfers.

The Hermes API-server profile is configured with an empty platform toolset.
This keeps shell, PTY, spawn, arbitrary filesystem, and generic HTTP tools out
of the COO path; structured actions are executed by Mission Control only.
