# Hermes COO model policy

Hermes COO inference uses the following routing policy:

- Primary: `openrouter / deepseek/deepseek-v4-flash`.
- Fallback: the approved, known-working OpenRouter GPT-4.1-mini profile.
- Fallback is bounded to one attempt and is used only for a provider/model failure or unusable model response. A short or disagreeable answer is not a fallback condition.
- Scheduled jobs that require predictable model and cost behavior are explicitly pinned. The `daily-ceo-brief` job is pinned to the primary above; interactive model changes must not alter that schedule.
- Provider credentials remain in the existing runtime/profile configuration and are never stored in this document.

Model resolution retains the supported hierarchy: global catalog, tenant default, agent override, and workflow/task override. This document describes policy only; it is not a second configuration source.
