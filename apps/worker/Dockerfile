FROM node:20-alpine AS base

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/

RUN pnpm install --frozen-lockfile

COPY packages/db ./packages/db
COPY apps/worker ./apps/worker

RUN pnpm --filter=@batchsender/db build
RUN pnpm --filter=worker build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 worker

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./

COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/db/dist ./packages/db/dist

RUN pnpm install --frozen-lockfile --prod

USER worker

EXPOSE 6001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:6001/health || exit 1

CMD ["node", "apps/worker/dist/index.js"]
