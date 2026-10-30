#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v docker >/dev/null 2>&1 || { echo 'Install Docker Engine/Desktop with Compose first.' >&2; exit 1; }
docker compose version >/dev/null
docker compose up --build -d --wait
echo 'Luna Translator is ready. Default URL: http://localhost:8088'
echo 'Deployment password (generated on first startup):'
docker compose exec -T backend sh -c 'if [ -n "$ADMIN_PASSWORD" ]; then echo "Use ADMIN_PASSWORD from your private .env"; else cat /data/admin-password; fi'
echo
