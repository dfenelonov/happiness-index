# Прод-образ «Индекс счастья». Сборка: docker compose build. Данные SQLite — в томе /data.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATABASE_URL=file:/data/app.db
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/config ./config
COPY --from=build /app/prompts ./prompts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
# При старте: миграции → seed для перцентиля (если SEED_ON_START=true) → сервер
CMD ["sh", "-c", "node --import tsx scripts/migrate.ts && if [ \"${SEED_ON_START:-true}\" = \"true\" ]; then node --import tsx scripts/seed.ts; fi && exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT}"]
