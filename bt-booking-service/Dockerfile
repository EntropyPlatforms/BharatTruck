# =============================================================================
#  bt-booking-service — Multi-stage Dockerfile
#  Port: 3002
# =============================================================================
#  BUILD CONTEXT IS THE REPO ROOT, not this directory:
#      docker build -f bt-booking-service/Dockerfile .
#  (CD does this via cloudbuild.yaml — see that file for why.)
#
#  This service depends on the shared library as `file:../packages/shared`. That path only
#  resolves if packages/shared is INSIDE the build context and sits one level up from the
#  service, so every stage below recreates the repo layout under /repo:
#      /repo/packages/shared
#      /repo/bt-booking-service   <- WORKDIR for npm
#  `.npmrc` (install-links=true) then makes npm COPY shared into node_modules rather than
#  symlink it, so its transitive deps hoist and resolve at runtime.
# =============================================================================

# --- deps: production node_modules only -------------------------------------
FROM node:20-alpine AS deps
WORKDIR /repo
# Shared first: it changes far less often than the service, so this layer stays cached.
# Only package.json + dist are needed — shared's package.json declares `files: ["dist"]`.
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
COPY bt-booking-service/package.json bt-booking-service/package-lock.json bt-booking-service/.npmrc ./bt-booking-service/
WORKDIR /repo/bt-booking-service
RUN npm ci --omit=dev

# --- development: hot-reload target for local compose ------------------------
FROM node:20-alpine AS development
WORKDIR /repo
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
COPY bt-booking-service/package.json bt-booking-service/package-lock.json bt-booking-service/.npmrc ./bt-booking-service/
WORKDIR /repo/bt-booking-service
RUN npm ci
COPY bt-booking-service/tsconfig.json ./
COPY bt-booking-service/src ./src
EXPOSE 3002
ENV NODE_ENV=development
CMD ["node_modules/.bin/tsx", "watch", "src/index.ts"]

# --- builder: compile TypeScript --------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /repo
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist
COPY bt-booking-service/package.json bt-booking-service/package-lock.json bt-booking-service/.npmrc bt-booking-service/tsconfig.json ./bt-booking-service/
WORKDIR /repo/bt-booking-service
RUN npm ci
COPY bt-booking-service/src ./src
RUN npm run build

# --- production --------------------------------------------------------------
FROM node:20-alpine AS production
WORKDIR /app
# node_modules already contains a COPY of @bharattruck/shared (install-links), so the
# runtime image needs no packages/ directory of its own.
COPY --from=deps    /repo/bt-booking-service/node_modules ./node_modules
COPY --from=builder /repo/bt-booking-service/dist         ./dist
COPY bt-booking-service/package.json ./
EXPOSE 3002
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
