# Builds any service in apps/*: docker build --build-arg APP=gateway -t minh-gateway .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
RUN pnpm install --frozen-lockfile --filter "@minh/${APP}..."
RUN pnpm --filter "@minh/${APP}" build
RUN pnpm --filter "@minh/${APP}" deploy --prod --legacy /out

FROM node:22-slim AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/${APP}/dist ./dist
USER node
CMD ["node", "dist/index.js"]
