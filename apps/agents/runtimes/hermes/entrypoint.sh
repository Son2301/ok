#!/bin/sh
# UNVERIFIED TEMPLATE — renders Hermes' config from the four variables the
# control plane injects, starts the Hermes API server on loopback, then runs
# the Minh runtime shim (upstream mode) as the container's front door on :8080.
set -eu

: "${MINH_AGENT_ID:?}" "${MINH_RUNTIME_TOKEN:?}" "${MINH_CONTROL_PLANE_URL:?}" "${MINH_GATEWAY_URL:?}"

MINH_UPSTREAM_API_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export MINH_UPSTREAM_API_KEY

mkdir -p "$HOME/.hermes"
sed \
  -e "s|__OK_GATEWAY_URL__|${MINH_GATEWAY_URL}|g" \
  -e "s|__OK_RUNTIME_TOKEN__|${MINH_RUNTIME_TOKEN}|g" \
  -e "s|__OK_MCP_URL__|${MINH_CONTROL_PLANE_URL}/mcp/${MINH_AGENT_ID}|g" \
  /opt/minh/config.yaml.template > "$HOME/.hermes/config.yaml"
chmod 600 "$HOME/.hermes/config.yaml"

# Hermes' OpenAI-compatible API server (gateway "api_server" platform), loopback only.
API_SERVER_ENABLED=true API_SERVER_HOST=127.0.0.1 API_SERVER_PORT=8642 API_SERVER_KEY="$MINH_UPSTREAM_API_KEY" \
  hermes gateway &
HERMES_PID=$!
trap 'kill "$HERMES_PID" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:8642/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done

exec node /opt/minh/runtime.js
