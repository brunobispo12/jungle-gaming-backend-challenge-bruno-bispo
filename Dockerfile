FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/bootstrap/main.ts"]
