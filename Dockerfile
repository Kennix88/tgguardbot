# syntax=docker/dockerfile:1.7

# ---- Build stage ----
# NOTE: using node:20-slim (Debian) instead of node:20-alpine.
# Alpine ships OpenSSL 3.x but lacks libssl 1.1, which crashes the Prisma
# schema/query engine with "Could not parse schema engine response".
# Debian slim works with Prisma out of the box.
FROM node:20-slim AS builder
WORKDIR /app

# Install dependencies (cache layer)
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Generate Prisma client and compile TypeScript
RUN npx prisma generate
RUN npx tsc --build

# ---- Production stage ----
FROM node:20-slim AS production
WORKDIR /app

ENV NODE_ENV=production

# Install OpenSSL libs needed by the Prisma engine (present on slim, but
# pinned explicitly so a future base image change can't silently break it),
# plus the PostgreSQL 16 client so the super-admin `/backup` command can run
# `pg_dump` (version-matched to the postgres:16 DB service).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends openssl postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*

# Install production deps (incl. `prisma` CLI, which lives in dependencies).
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Entrypoint: apply migrations, then start
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["docker-entrypoint.sh"]
