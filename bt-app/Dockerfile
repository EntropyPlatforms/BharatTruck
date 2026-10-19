# bt-app — the unified BharatTruck front door. Next.js 16 standalone container for Cloud Run.
# Cloud Run service name: bt-app. Forked from fleet/Dockerfile (the strongest UI we have, per D-36);
# the build recipe is identical, only the branding/service-name comments differ.
#
# NEXT_PUBLIC_* are PUBLIC (inlined into client JS) so they are baked at BUILD time, not injected
# at runtime. CI (.github/workflows/deploy.yml) passes them via `docker build --build-arg` from
# GitHub repo variables/secrets — NO Maps key is committed here.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# --- Build-time public config (declared AFTER npm ci so the deps layer stays cacheable) ---
# API_URL keeps a sane default (the prod gateway). The Maps browser key and Map ID have NO default:
# they are injected by CI, so a build that forgets to pass them ships empty (fails loud) rather than
# baking a stale/committed key. The live map degrades to a clear "key not configured" panel in that
# case rather than a blank screen.
ARG NEXT_PUBLIC_API_URL=https://bt-gateway-itcdoenefa-el.a.run.app
ARG NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
# The Google OAuth WEB client id — the same credential bt-auth-service verifies against as
# GOOGLE_CLIENT_ID. No default: unset hides the "Continue with Google" button rather than
# rendering a dead one, so the button only appears once CI passes the value.
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
ENV NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=$NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
# `bt-app/public` is currently EMPTY, and git does not track empty directories — so the CI
# checkout has no public/ at all and the runner stage's `COPY /app/public` fails the build with
# `"/app/public": not found`. Create it unconditionally rather than dropping the COPY, so the
# image still picks up assets the moment anyone adds a favicon or icon here.
RUN mkdir -p public && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
