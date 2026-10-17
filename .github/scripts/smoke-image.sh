#!/usr/bin/env bash
set -euo pipefail
: "${IMAGE_REF:?IMAGE_REF is required}"
name="backend-smoke-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

# Ephemeral CI PostgreSQL only: no production environment or VPS credentials.
docker run --detach --name "$name" --init --read-only --network host \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --tmpfs /app/data:rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=0700 \
  --tmpfs /app/uploads:rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=0700 \
  -e DATABASE_URL=postgresql://postgres:ci-only-password@127.0.0.1:5432/image_smoke \
  -e APP_ORIGIN=https://example.test -e STARTUP_TIMEOUT=30 -e WEB_CONCURRENCY=1 \
  -e ADMIN_PASSWORD=ci-only-smoke-passphrase -e RAIS_PASSWORD=ci-only-smoke-passphrase \
  -e NEWS_FETCH=off -e TZ=Asia/Tashkent "$IMAGE_REF"

ready=false
for attempt in {1..30}; do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]]; then break; fi
  if docker exec "$name" node -e \
    'fetch("http://127.0.0.1:4321/api/health/ready",{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))'; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  docker logs "$name"
  echo 'Published image did not become ready against CI PostgreSQL.' >&2
  exit 1
fi
docker exec "$name" sh -ec '
  test "$(id -u)" = 10001
  test ! -d /usr/local/lib/node_modules/npm
  unzip -v >/dev/null
  node -e '\''for(const pkg of ["pg","exceljs","qrcode","ws","@anthropic-ai/sdk"])require(pkg);if(new Date("2026-10-17T00:00:00Z").getTimezoneOffset()!==-300)process.exit(1)'\''
'
docker stop --time 30 "$name" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
echo 'Published image passed PostgreSQL readiness, non-root/read-only startup, package imports, unzip, timezone and graceful shutdown.'
