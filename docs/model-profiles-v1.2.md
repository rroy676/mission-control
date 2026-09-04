# Blueprint v1.2: Tenant Model Profiles

Mission Control model selection is represented by a global allowlist and tenant-owned profiles. The catalog contains provider/model metadata only; it never contains API keys.

## Data model

- `model_provider_catalog`: global provider/model metadata, enablement, deprecation, capabilities, pricing metadata, and manually managed promotional state.
- `tenant_credentials`: tenant-owned metadata references such as `tenant-a/openrouter/primary`. The table stores no secret value.
- `tenant_model_profiles`: tenant-owned model selections. Profiles carry provider/model, purpose, scope, priority, optional agent/workflow/task target, credential reference, fallback reference, promotional state, and validity windows.
- `tenant_model_usage`: tenant-scoped future attribution contract for token/cost records.

Every profile and credential lookup is constrained by the authenticated membership-backed tenant context. Foreign profile, target, and credential references fail closed.

## Resolution

`resolveEffectiveModel` is the single resolver used by the profile API. Its precedence is:

`global allowed catalog → tenant default → agent override → workflow override → task override`

The last three entries are increasingly specific overrides; task resolution is checked first. A profile must be enabled, within its effective/expiry window, globally allowed, and backed by a same-tenant non-revoked credential reference when one is supplied. Fallbacks are ordered profile references and are never selected from another tenant. If no authorized profile remains, resolution returns `null` with no arbitrary global fallback.

## Authorization and UI

Owners and admins may create, enable, disable, and remove profiles or register credential-reference metadata. Operators and viewers may read profiles and effective results. The model configuration panel is intentionally small: it identifies the active tenant and supports tenant defaults and agent overrides without source or `.env` edits. UI selection does not grant membership; the server resolves and validates the tenant on every request.

Workflow/task profile columns and resolver inputs are present as the next integration foundation. Existing resource routes are not universally tenant-repository-backed, so a second production tenant remains disabled until those routes are migrated.

Promotional/free status and expiry are explicit operator-managed metadata. There is no live provider discovery, price polling, automatic switching, or secret storage in this slice.

Meaningful configuration and denied authorization decisions are recorded in the existing bounded audit systems without secrets, tokens, passwords, or session values.
