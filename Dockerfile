FROM oven/bun:1.4 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
# Migrations are idempotent: every instance may run them on start.
CMD ["sh", "-c", "bun src/scripts/migrate.ts up && exec bun src/main.ts"]
