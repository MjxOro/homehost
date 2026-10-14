FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile
COPY . .
# Commit the bundle is built from: baked into the JS and dist/version.json so
# open tabs can tell a newer deploy is live. Empty (CI) disables the check.
ARG BUILD_SHA=
RUN cd apps/web && VITE_BUILD_SHA="$BUILD_SHA" bun run build

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
