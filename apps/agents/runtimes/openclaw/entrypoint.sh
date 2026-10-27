#!/bin/sh
# UNVERIFIED TEMPLATE — renders OpenClaw's config from the four variables the
# control plane injects, starts OpenClaw on loopback, then runs the Minh runtime
# shim (upstream mode) as the container's front door on :8080.
set -eu

: "${MINH_AGENT_ID:?}" "${MINH_RUNTIME_TOKEN:?}" "${MINH_CONTROL_PLANE_URL:?}" "${MINH_GATEWAY_URL:?}"

# Per-container secret between the shim and OpenClaw's local gateway (never leaves the container).
MINH_UPSTREAM_API_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export MINH_UPSTREAM_API_KEY

mkdir -p "$HOME/.openclaw"
sed \
  -e "s|__OK_GATEWAY_URL__|${MINH_GATEWAY_URL}|g" \
  -e "s|__OK_RUNTIME_TOKEN__|${MINH_RUNTIME_TOKEN}|g" \
  -e "s|__OK_MCP_URL__|${MINH_CONTROL_PLANE_URL}/mcp/${MINH_AGENT_ID}|g" \
  -e "s|__OK_UPSTREAM_API_KEY__|${MINH_UPSTREAM_API_KEY}|g" \
  /opt/minh/openclaw.json.template > "$HOME/.openclaw/openclaw.json"
chmod 600 "$HOME/.openclaw/openclaw.json"

openclaw gateway --bind loopback --port 18789 &
OPENCLAW_PID=$!
trap 'kill "$OPENCLAW_PID" 2>/dev/null || true' EXIT INT TERM

# Wait for the local gateway before accepting turns.
for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:18789/').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done

exec node /opt/minh/runtime.js
