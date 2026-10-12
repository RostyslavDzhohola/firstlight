# Game server image for Railway. Node 24 runs the TypeScript sources directly (type stripping).
FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter @firstlight/server...
ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567
CMD ["node", "apps/server/src/main.ts"]
