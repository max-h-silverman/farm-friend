# Farm Friend — the container that runs on Cloud Run.
#
# One image, two services. `DEPLOYMENT_ROLE` (web|worker) decides which surfaces a given
# revision exposes; the artifact is identical and both services are pinned to the same
# digest, so a deploy can never put two different builds in front of one database.
#
# The build context is the REPO ROOT, not apps/web: the app imports four workspace packages
# that ship raw TypeScript, and a Dockerfile inside the app directory cannot reach out of
# its own context to reach them.

# ---------------------------------------------------------------------------
# deps — install against the real workspace manifests, in an isolated container.
# ---------------------------------------------------------------------------
# This stage is where B-005..B-008's whole defect class would surface. Locally npm
# workspaces hoists, so a missing or misdeclared dependency resolves anyway and every
# suite passes; here there is no hoisted tree to fall back on, and an undeclared dep is a
# hard build failure. That is a feature — this is the isolated install the repo has been
# unable to test any other way.
FROM node:20-slim AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually changes.
# Each workspace package needs its own package.json present for `npm ci` to link them.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/ai/package.json ./packages/ai/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/sms/package.json ./packages/sms/

RUN npm ci

# ---------------------------------------------------------------------------
# build — compile the Next app into a standalone server.
# ---------------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Telemetry is off in the image: it is an outbound network call from a container that
# should only ever talk to Neon, Telnyx, and the model provider.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build --workspace @farm-friend/web

# ---------------------------------------------------------------------------
# runtime — the standalone server alone. No source, no build toolchain, no dev deps.
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Cloud Run assigns the port and the container must honour it. A hard-coded port fails the
# startup probe with no useful message. The default matches Next's own so a plain
# `docker run` works locally without arguments.
ENV PORT=8080
EXPOSE 8080

# Run as a non-root user. `node` already exists in this base image with uid 1000.
# Nothing in the runtime layer needs write access — the app's only durable state is Neon.
USER node

# The three artifacts a standalone build produces. `.next/static` is separate from the
# server bundle and easy to omit; without it the server boots and serves an unstyled,
# script-less page, which reads as a CSS bug rather than a packaging one.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

# The standalone bundle preserves the workspace layout, so the server entrypoint sits at
# the app's path within it rather than at the root.
CMD ["node", "apps/web/server.js"]
