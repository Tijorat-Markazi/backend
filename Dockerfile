# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ENV NODE_ENV=production PORT=4321 WEB_CONCURRENCY=1 STARTUP_TIMEOUT=120
WORKDIR /app
RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates tzdata unzip \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn* \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app -s /sbin/nologin app \
    && mkdir -p /app/data /app/uploads \
    && chown 10001:10001 /app/data /app/uploads \
    && chmod 0750 /app/data /app/uploads
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.js core.js db.js claude.js ws.js ./
COPY srv ./srv
COPY scripts ./scripts
COPY --chmod=0555 entrypoint.sh ./entrypoint.sh
USER 10001:10001
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=150s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4321/api/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
