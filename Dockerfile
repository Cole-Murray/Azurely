# syntax=docker/dockerfile:1

# Node pinned to the exact version this project is developed against
# (local node -v == 22.22.3). Pinning the patch, not just the major, so a
# base-image refresh is a deliberate commit rather than an invisible change.
# bookworm-slim (glibc) rather than alpine (musl): no native deps today, but
# glibc removes a whole class of "works locally, breaks in the container".
ARG NODE_VERSION=22.22.3

# ---------- stage 1: build (needs devDependencies for typescript) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- stage 2: production dependencies only ----------
# A separate stage (rather than pruning the dev tree) so the runtime
# node_modules is built by a clean --omit=dev install and nothing dev-only
# can survive into the final layer.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- stage 3: runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./
USER node
EXPOSE 8080
# No Dockerfile HEALTHCHECK on purpose: Azure Container Apps drives health from
# the probes block in the app spec, not from Docker's healthcheck.
#
# node runs as PID 1 here, and Linux does NOT deliver SIGTERM to PID 1 unless
# the process installs a handler (Node installs none by default). src/index.ts
# must register a SIGTERM handler or every Container Apps revision swap costs a
# 30-second SIGKILL wait with in-flight requests cut. That handler is added in a
# later step of this plan; this comment is here so the dependency is visible.
CMD ["node", "dist/index.js"]
