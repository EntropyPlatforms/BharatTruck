# =============================================================================
#  bt-auth-service — Multi-stage Dockerfile
#  Port: 3001
#
#  Stages:
#    deps        — production node_modules only (layer-cache optimised)
#    development — all deps + tsx watch (used by docker-compose)
#    builder     — compiles TypeScript to dist/
#    production  — lean runtime image (node dist/index.js)
#
#  docker-compose uses: target: development
#  CI/CD should build: target: production
# =============================================================================
#  BUILD CONTEXT IS THE REPO ROOT, not this directory:
#      docker build -f bt-auth-service/Dockerfile .
#  (CD does this via cloudbuild.yaml — see that file for why.)
#
#  This service depends on the shared library as `file:../packages/shared`. That path only
#  resolves if packages/shared is INSIDE the build context and sits one level up from the
#  service, so every stage below recreates the repo layout under /repo:
#      /repo/packages/shared
#      /repo/bt-auth-service      <- WORKDIR for npm
#  `.npmrc` (install-links=true) then makes npm COPY shared into node_modules rather than
#  symlink it, so its transitive deps hoist and resolve at runtime.
# =============================================================================

# ── Stage 1: production deps ──────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /repo
# bcrypt requires native compilation
RUN apk add --no-cache python3 make g++
# Shared first: it changes far less often than the service, so this layer stays cached.
# Only package.json + dist are needed — shared's package.json declares `files: ["dist"]`.
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
COPY bt-auth-service/package.json bt-auth-service/package-lock.json bt-auth-service/.npmrc ./bt-auth-service/
WORKDIR /repo/bt-auth-service
RUN npm ci --omit=dev

# ── Stage 2: development (hot-reload via tsx watch) ───────────────────────────
FROM node:20-alpine AS development
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
COPY bt-auth-service/package.json bt-auth-service/package-lock.json bt-auth-service/.npmrc ./bt-auth-service/
WORKDIR /repo/bt-auth-service
RUN npm ci
COPY bt-auth-service/tsconfig.json ./
COPY bt-auth-service/src ./src
EXPOSE 3001
ENV NODE_ENV=development
CMD ["node_modules/.bin/tsx", "watch", "src/index.ts"]

# ── Stage 3: TypeScript compiler ──────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
COPY bt-auth-service/package.json bt-auth-service/package-lock.json bt-auth-service/.npmrc bt-auth-service/tsconfig.json ./bt-auth-service/
WORKDIR /repo/bt-auth-service
RUN npm ci
COPY bt-auth-service/src ./src
RUN npm run build

# ── Stage 4: lean production image ────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
# node_modules already contains a COPY of @bharattruck/shared (install-links), so the
# runtime image needs no packages/ directory of its own.
COPY --from=deps    /repo/bt-auth-service/node_modules ./node_modules
COPY --from=builder /repo/bt-auth-service/dist         ./dist
COPY bt-auth-service/package.json ./
COPY bt-auth-service/public ./public
EXPOSE 3001
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
