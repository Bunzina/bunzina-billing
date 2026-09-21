FROM oven/bun:1.2 AS base

WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps

COPY bun.lock package.json bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production

FROM base AS runner

RUN addgroup --system app \
	&& adduser --system --ingroup app app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app package.json bunfig.toml tsconfig.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app migrations ./migrations

USER app

EXPOSE 3000

ENV PORT=3000

CMD ["bun", "run", "start"]
