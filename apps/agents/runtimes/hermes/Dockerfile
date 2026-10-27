# syntax=docker/dockerfile:1
#
# UNVERIFIED TEMPLATE — Hermes Agent (Nous Research) runtime image for the
# docker driver (AGENTS_IMAGE_HERMES). Written against Hermes' public docs;
# not yet tested end to end. Pin HERMES_REF to a release you have validated.
#
# Build from the repository root (after `pnpm --filter @minh/agents build`):
#   docker build -f apps/agents/runtimes/hermes/Dockerfile -t ok/agents-runtime-hermes:latest .
#
# How it fits:
#   control plane --signed POST /turn--> [ok runtime shim :8080, upstream mode]
#        --> Hermes API server on 127.0.0.1:8642 (OpenAI-compatible /v1/chat/completions)
#   Hermes' model endpoint = MINH_GATEWAY_URL (control-plane LLM proxy), key = MINH_RUNTIME_TOKEN
#   Hermes' tools          = MCP server MINH_CONTROL_PLANE_URL/mcp/MINH_AGENT_ID (Bearer MINH_RUNTIME_TOKEN)

FROM python:3.12-slim
ARG HERMES_REF=main
# Node runs the Minh runtime shim (front door + health check).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "git+https://github.com/NousResearch/hermes-agent.git@${HERMES_REF}"
RUN useradd --system --uid 10001 --create-home --home-dir /home/agent --shell /usr/sbin/nologin agent
COPY apps/agents/dist/runtime.js /opt/minh/runtime.js
COPY apps/agents/runtimes/hermes/config.yaml.template /opt/minh/config.yaml.template
COPY --chmod=0755 apps/agents/runtimes/hermes/entrypoint.sh /opt/minh/entrypoint.sh
ENV PORT=8080 MINH_RUNTIME_MODE=upstream MINH_UPSTREAM_URL=http://127.0.0.1:8642/v1 MINH_UPSTREAM_MODEL=hermes-agent
USER 10001:10001
WORKDIR /home/agent
EXPOSE 8080
ENTRYPOINT ["/opt/minh/entrypoint.sh"]
