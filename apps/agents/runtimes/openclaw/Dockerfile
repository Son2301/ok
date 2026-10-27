# syntax=docker/dockerfile:1
#
# UNVERIFIED TEMPLATE — OpenClaw runtime image for the docker driver
# (AGENTS_IMAGE_OPENCLAW). Written against OpenClaw's public docs; not yet
# tested end to end. Pin OPENCLAW_VERSION to a release you have validated.
#
# Build from the repository root (after `pnpm --filter @minh/agents build`):
#   docker build -f apps/agents/runtimes/openclaw/Dockerfile -t ok/agents-runtime-openclaw:latest .
#
# How it fits:
#   control plane --signed POST /turn--> [ok runtime shim :8080, upstream mode]
#        --> OpenClaw gateway on 127.0.0.1:18789 (OpenAI-compatible /v1/chat/completions)
#   OpenClaw's model provider  = MINH_GATEWAY_URL (control-plane LLM proxy; quota, budget, billing)
#   OpenClaw's tools           = MCP server MINH_CONTROL_PLANE_URL/mcp/MINH_AGENT_ID (Bearer MINH_RUNTIME_TOKEN)
# Third-party credentials never enter this container.

FROM node:22-bookworm-slim
ARG OPENCLAW_VERSION=latest
RUN npm install -g "openclaw@${OPENCLAW_VERSION}" && npm cache clean --force
RUN useradd --system --uid 10001 --create-home --home-dir /home/agent --shell /usr/sbin/nologin agent
COPY apps/agents/dist/runtime.js /opt/minh/runtime.js
COPY apps/agents/runtimes/openclaw/openclaw.json.template /opt/minh/openclaw.json.template
COPY --chmod=0755 apps/agents/runtimes/openclaw/entrypoint.sh /opt/minh/entrypoint.sh
ENV NODE_ENV=production PORT=8080 MINH_RUNTIME_MODE=upstream \
    MINH_UPSTREAM_URL=http://127.0.0.1:18789/v1 MINH_UPSTREAM_MODEL=openclaw
USER 10001:10001
WORKDIR /home/agent
EXPOSE 8080
ENTRYPOINT ["/opt/minh/entrypoint.sh"]
