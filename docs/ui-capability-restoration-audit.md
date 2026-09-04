# Mission Control UI/capability restoration audit

Audit date: 2026-09-04. Comparison target: `upstream/main` at
`5483a0e1eef15b467c167e95796791112cedbb7c`. Fork: `rroy676/mission-control`,
currently `main` at `5088ccd` plus this audit change.

## Finding

The native panels were still implemented and routed in the fork. The main
accidental loss was in `src/components/layout/nav-rail.tsx`: a custom
`observabilityOnlyPanels` filter removed most of the native navigation in every
interface mode, including Full mode. Upstream does not have that filter. It
has been removed. Essential mode still uses the existing explicit
`ESSENTIAL_PANELS` guard; Full mode now exposes the complete native hub.

## Native inventory

| Area | Native panel/API in fork | UI state | Classification |
|---|---|---|---|
| Home/company | Overview, Company Observability, dashboard/status APIs | visible | Restore/keep |
| Projects | project switcher, projects and project task APIs | visible in context switcher | Restore/keep |
| Agents | Agents, agent details, diagnostics, files, memory, heartbeat APIs | visible | Restore/keep; mutating agent controls remain policy-bound |
| Tasks/engineering | Tasks, comments, outcomes, branch, queue, quality review APIs | visible | Restore/keep; execution remains bounded |
| Chat/sessions | Chat, transcript/session APIs | visible in Full mode | Restore/keep; terminal view remains blocked |
| Activity/history | Activity, notifications, standup, events APIs | visible or reachable by command palette | Restore/keep |
| Observability | Logs, Monitor, Alerts, Audit, Security, Debug | visible in Full mode | Restore/keep |
| Cost/tokens | Cost Tracker, token APIs | visible in Full mode | Restore/keep; token rotation remains blocked |
| GitHub/releases | GitHub Sync, GitHub APIs, release check/update APIs | visible in Full mode | Read/status keep; mutation/external write bounded later |
| Automation | Cron, Webhooks, Workflows, Pipelines | visible in Full mode | Keep; run/mutation authority review required |
| Integrations/settings | Integrations, Settings, gateway config | visible in Full mode | Restore/keep; credential mutation stays blocked |
| Gateway/system | Gateways, Nodes, Channels, Office, System Monitor | visible subject to gateway/local mode | Keep; OpenClaw dependency documented below |
| Admin | Users, super-admin, Security, Audit | visible by existing role paths | Keep with admin auth |

All corresponding upstream routes remain present in the fork. No panel or API
was deleted by the v1.1 hardening. The fork additionally contains the Company
Observability panel/API, bounded PAUSE route, embedded authority package, and
security proxy changes.

## `MC_OBSERVABILITY_ONLY`

The old proxy branch was broader than its name suggested: it denied many
native mutation APIs and several whole paths, while the navigation filter hid
useful panels regardless of the flag. The flag is not present in this
checkout's `.env`, but remains a possible deployment environment variable.

It now acts as a compatibility safety profile. It blocks terminal, PTY,
arbitrary spawn, gateway control/connect, OS-user/super-admin operations,
OpenClaw doctor/update, session continuation, agent messaging/optimization or
registration, pipeline/release/delivery execution, token rotation, cleanup,
and mutating setup/onboarding/approval/config paths. It does not hide panels
and does not block read-only APIs or ordinary authenticated hub CRUD. This
preserves security while avoiding the old observability-only product model.

## Classification

Restore/keep: projects, agents, tasks, activity/history, GitHub/CI/release
status, schedules, notifications, workflows, audit, logs/diagnostics,
cost/token visibility, memory, integrations, system health, pipelines status,
approvals visibility, and Company Observability.

Restore with bounded authority: PAUSE (currently shadow comparison), future
PILOT/objectives/approvals, authorized engineering execution, controlled
restart/deploy, and workflow/pipeline execution. These must use explicit
typed authority capabilities and are not enabled by removing the UI filter.

Keep blocked: arbitrary terminal, unrestricted PTY/spawn/shell, OS-user
provisioning, unrestricted gateway control, OpenClaw doctor/update, direct
credential or filesystem mutation, direct financial mutation, and any
bypass-capable execution route.

OpenClaw-specific panels are retained only where they are useful as native
code or status surfaces. OpenClaw is not reinstalled or reconnected. Gateway,
Channels, Nodes, and gateway-backed Office behavior may show the existing
local-mode/unavailable state; Hermes/company views are the replacement path.

## Proposed hub navigation

Keep the existing grouping because it already maps cleanly to the target:
Core (Overview, Company, Agents, Tasks, Chat, Memory), Observe (Activity,
Logs, Cost, Monitor, Audit), Automate (Cron, Webhooks, Alerts, GitHub), and
Admin/System (Security, Integrations, Settings, Gateway, Users). Project
selection remains in the context switcher. Future company views should be
added as panels/API extensions, not by replacing the native registry.

## Validation status

Static inventory and upstream comparison are complete. The low-risk nav
restoration is applied. Typecheck/unit/build and authenticated production URL
checks remain deployment validation steps; no production mutation or OpenClaw
reconnection was performed during this audit. The broker migration is paused
until this restored hub is deployed and its read-only surface is live-checked.
