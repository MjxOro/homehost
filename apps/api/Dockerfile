# Builder: full workspace (bun workspaces resolve @homehost/shared from source).
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile
COPY . .
RUN bun --cwd apps/api run build

# Runtime: compiled api + ledger-tracked migrations + shared source.
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/packages/shared ./packages/shared
COPY infra/prod/api-entrypoint.sh ./infra/prod/api-entrypoint.sh
ENV HOST=0.0.0.0 PORT=3000
ENTRYPOINT ["bash", "infra/prod/api-entrypoint.sh"]
