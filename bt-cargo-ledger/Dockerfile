# =============================================================================
#  bt-cargo-ledger — Multi-stage Dockerfile
#  Port: 3005
# =============================================================================

# BUILD CONTEXT IS THE REPO ROOT (docker build -f bt-cargo-ledger/Dockerfile .), so every COPY
# source below is repo-relative. CD builds all services this way via cloudbuild.yaml —
# uniform with bt-booking-service/bt-tracking-service, which REQUIRE a root context to
# resolve their `file:../packages/shared` dependency.

FROM node:20-alpine AS deps
WORKDIR /app
COPY bt-cargo-ledger/package.json bt-cargo-ledger/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS development
WORKDIR /app
COPY bt-cargo-ledger/package.json bt-cargo-ledger/package-lock.json ./
RUN npm ci
COPY bt-cargo-ledger/tsconfig.json ./
COPY bt-cargo-ledger/src ./src
EXPOSE 3005
ENV NODE_ENV=development
ENV BLOCKCHAIN_ENABLED=false
CMD ["node_modules/.bin/tsx", "watch", "src/index.ts"]

FROM node:20-alpine AS builder
WORKDIR /app
COPY bt-cargo-ledger/package.json bt-cargo-ledger/package-lock.json bt-cargo-ledger/tsconfig.json ./
RUN npm ci
COPY bt-cargo-ledger/src ./src
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY bt-cargo-ledger/package.json ./
EXPOSE 3005
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
