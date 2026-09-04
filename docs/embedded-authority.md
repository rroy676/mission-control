# Embedded authority: Blueprint v1.2 Phase 1

Mission Control contains a PAUSE-only embedded authority package under
`src/lib/authority/`. It is a typed policy boundary, not an execution engine.
Unknown fields, actions, requesters, and malformed requests are rejected. It
has no shell, PTY, spawn, generic execute endpoint, or authority-file writer.

## Shadow flow

An authenticated admin request is evaluated by the embedded policy and sent
through the constrained reference adapter to Hermes' loopback PAUSE endpoint.
Mission Control stores the comparison in its own structured data directory
and exposes it through `/api/autonomous-company`; only Hermes/CommandBroker
can write the standalone dispatch authority state.

The comparison records request ID, authenticated requester, both verdicts,
allow/deny, reason code, equivalence, mismatch, timestamp, and authoritative
result. A disagreement or reference outage fails safe and blocks promotion.
There is no direct file-mutation fallback.

## Fork maintenance

`origin` is `https://github.com/rroy676/mission-control.git`; `upstream` is
`https://github.com/builderz-labs/mission-control.git`. Sync with:

```sh
git fetch upstream
git rebase upstream/main
pnpm typecheck && pnpm test && pnpm build
git push origin main
```

Review conflicts in authority modules, the observability panel, and the
autonomous-company control/status APIs. Push custom work only to `origin`.

PAUSE remains shadow-only until repeated equivalence, idempotency, malformed
request rejection, outage safety, mismatch blocking, audit correctness, and
clean authority tests are evidenced live.
