# Standalone observability

Mission Control can run without an OpenClaw gateway. In that mode, the Logs
panel reads only the bounded, operator-configured Mission Control log
directory (`MC_LOG_DIR`). If it is not set, the directory is
`.data/logs`. OpenClaw logs are read only when `OPENCLAW_LOG_DIR` is explicitly
configured or `OPENCLAW_ENABLED=1`; the panel never accepts an arbitrary path
from the browser.

The System Monitor panel is OpenClaw-independent. Its read-only API collects
CPU, memory, disk, network counters, and a bounded list of process summaries
using platform APIs and fixed command argument lists. It does not expose shell
execution, gateway RPC, or filesystem browsing. Optional GPU data is omitted
when the host has no supported GPU probe.

If a deployment or reverse proxy cannot reach Mission Control, these APIs may
temporarily produce an upstream 502. That is a service availability failure,
not an OpenClaw dependency. The panels surface the limited/unavailable state
instead of treating it as gateway configuration. Gateway-dependent panels
remain intentionally unavailable in standalone mode.

GitHub remains `NOT CONFIGURED` until a token and repository configuration are
provided.
