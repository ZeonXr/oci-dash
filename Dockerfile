FROM node:26.13.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:26.13.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 DATABASE_PATH=/data/oci-dash.db TMPDIR=/dev/shm
LABEL org.opencontainers.image.source="https://github.com/ZeonXr/oci-dash" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Self-hosted OCI management console"
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates tini && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/LICENSE ./LICENSE
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/health.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/runtime.mjs"]
