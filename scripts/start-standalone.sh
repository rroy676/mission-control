#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$PROJECT_ROOT/scripts/load-env.sh"
REQUESTED_HOSTNAME="${HOSTNAME:-}"
STANDALONE_DIR="$PROJECT_ROOT/.next/standalone"
STANDALONE_NEXT_DIR="$STANDALONE_DIR/.next"
STANDALONE_STATIC_DIR="$STANDALONE_NEXT_DIR/static"
SOURCE_STATIC_DIR="$PROJECT_ROOT/.next/static"
SOURCE_PUBLIC_DIR="$PROJECT_ROOT/public"
STANDALONE_PUBLIC_DIR="$STANDALONE_DIR/public"

if [[ ! -f "$STANDALONE_DIR/server.js" ]]; then
  echo "error: standalone server missing at $STANDALONE_DIR/server.js" >&2
  echo "run 'pnpm build' first" >&2
  exit 1
fi

mkdir -p "$STANDALONE_NEXT_DIR"

if [[ -d "$SOURCE_STATIC_DIR" ]]; then
  rm -rf "$STANDALONE_STATIC_DIR"
  cp -R "$SOURCE_STATIC_DIR" "$STANDALONE_STATIC_DIR"
fi

if [[ -d "$SOURCE_PUBLIC_DIR" ]]; then
  rm -rf "$STANDALONE_PUBLIC_DIR"
  cp -R "$SOURCE_PUBLIC_DIR" "$STANDALONE_PUBLIC_DIR"
fi

cd "$STANDALONE_DIR"

# Load .env as literal configuration if it exists (consistent with Docker).
# NEXT_PUBLIC_* vars are already baked into the bundle at build time,
# but server-side vars (AUTH_*, OPENCLAW_*, etc.) need this to take effect.
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  load_env_file "$PROJECT_ROOT/.env"
fi

export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$PROJECT_ROOT/.data}"

# Next.js standalone server reads HOSTNAME to decide bind address.
# Default to 0.0.0.0 so the server is accessible from outside the host.
# Preserve a caller-supplied bind address across .env loading. Deployment
# passes the internal interface explicitly; machine hostname DNS is not part
# of the listener contract.
export HOSTNAME="${REQUESTED_HOSTNAME:-${HOSTNAME:-0.0.0.0}}"
NODE_BIN="${MC_NODE_BIN:-node}"
if [[ ! -x "$NODE_BIN" ]] && ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "error: configured Node binary is unavailable: $NODE_BIN" >&2
  exit 1
fi
if [[ -f "$PROJECT_ROOT/.nvmrc" ]]; then
  expected_major="$(tr -d '[:space:]v' < "$PROJECT_ROOT/.nvmrc" | cut -d. -f1)"
  actual_major="$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [[ -n "$expected_major" && "$actual_major" != "$expected_major" ]]; then
    echo "error: Node $actual_major does not match project Node major $expected_major; set MC_NODE_BIN" >&2
    exit 1
  fi
fi
exec "$NODE_BIN" server.js
