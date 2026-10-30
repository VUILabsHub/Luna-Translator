$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Install Docker Desktop with Compose first.' }
docker compose up --build -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Deployment failed. Inspect docker compose logs.' }
Write-Host 'Luna Translator: http://localhost:8088'
Write-Host 'Deployment password (generated on first startup):'
docker compose exec -T backend sh -c 'if [ -n "$ADMIN_PASSWORD" ]; then echo "Use ADMIN_PASSWORD from your private .env"; else cat /data/admin-password; fi'
