# Web console + landing (Next.js standalone output). Build from the repo root:
#   docker build -f apps/web/Dockerfile -t ok-web .
# Runtime env: DATABASE_URL (same Postgres as the services), INTERNAL_TOKEN, GATEWAY_URL,
# AGENTS_URL, SAFE_URL, REVIEW_URL, PUBLIC_API_URL … (see apps/web/README.md).
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter "@ok/web..."
ENV NEXT_OUTPUT=standalone
RUN pnpm --filter @ok/web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# The standalone tree mirrors the monorepo layout; server.js lives in apps/web.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
