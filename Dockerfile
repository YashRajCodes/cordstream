FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    STREAM_DATABASE_PATH=/app/data/cordstream.sqlite

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun public ./public
RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun
EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
