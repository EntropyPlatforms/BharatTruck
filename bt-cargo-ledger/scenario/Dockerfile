# =============================================================================
#  bt-scenario-runner — the backend of the test portal's "Try your own scenario" form.
#  Runs scenario/server.mts: the real booking + delivery-code code on an in-memory
#  database. Holds no secret and reaches no live system.
# =============================================================================
#  BUILD CONTEXT IS THE REPO ROOT:
#      docker build -f bt-cargo-ledger/scenario/Dockerfile .
#  The engine imports bt-booking-service's SOURCE, and booking depends on the shared library
#  as `file:../packages/shared`, so the image recreates the repo layout under /repo:
#      /repo/packages/shared        (package.json + committed dist)
#      /repo/bt-booking-service     (src + its own node_modules)
#      /repo/bt-cargo-ledger        (src + scenario + its own node_modules, incl. tsx)
#  It runs the TypeScript directly with tsx (a dev dependency), so `npm ci` here is a full
#  install, not --omit=dev. This is a demo/test service, not a production path.
# =============================================================================
FROM node:20-alpine
WORKDIR /repo

COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/dist ./packages/shared/dist

COPY bt-booking-service/package.json bt-booking-service/package-lock.json bt-booking-service/.npmrc ./bt-booking-service/
RUN cd bt-booking-service && npm ci

COPY bt-cargo-ledger/package.json bt-cargo-ledger/package-lock.json ./bt-cargo-ledger/
RUN cd bt-cargo-ledger && npm ci

COPY bt-booking-service/tsconfig.json ./bt-booking-service/
COPY bt-booking-service/src ./bt-booking-service/src
COPY bt-cargo-ledger/tsconfig.json ./bt-cargo-ledger/
COPY bt-cargo-ledger/src ./bt-cargo-ledger/src
COPY bt-cargo-ledger/scenario ./bt-cargo-ledger/scenario

WORKDIR /repo/bt-cargo-ledger
ENV NODE_ENV=production
# Cloud Run sets PORT=8080.
EXPOSE 8080
USER node
CMD ["node_modules/.bin/tsx", "scenario/server.mts"]
