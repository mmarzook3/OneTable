param(
    [ValidateSet('local', 'vps')][string]$Target = 'local',
    [ValidateSet('core', 'extended', 'reservations', 'saas')][string]$Suite = 'core'
)
$ErrorActionPreference = 'Stop'
$tests = if ($Suite -eq 'core') {
    @('tests/test_offline_cash_order.py', 'tests/test_restaurant_groups.py')
} elseif ($Suite -eq 'saas') {
    @('tests/test_saas_billing.py')
} elseif ($Suite -eq 'reservations') {
    @('tests/test_reservation_book_zones_public.py',
      'tests/test_reservation_floor_seating_zone.py',
      'tests/test_close_table_finishes_seated_reservation.py')
} else {
    @('tests/test_customer_accounts.py', 'tests/test_customer_password_reset.py', 'tests/test_club_loyalty.py',
      'tests/test_platform_subscription_console.py', 'tests/test_public_satisfecho_delivery.py')
}
$arguments = (@('-q', '--tb=short', '-p', 'no:cacheprovider') + $tests | ForEach-Object { "'$_'" }) -join ','
$python = "from app.db import create_db_and_tables; from app import models; create_db_and_tables(); import pytest; raise SystemExit(pytest.main([$arguments]))"
if ($Target -eq 'vps') {
    $script = @'
set -euo pipefail
name="scanaki-phase3-tests-$(date +%s)-$$"
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
image="$(docker inspect scanaki-back --format '{{.Image}}')"
docker run -d --rm --name "$name" --network none --tmpfs /tmp:rw,size=512m -e PGDATA=/tmp/pgdata -e POSTGRES_USER=pos -e POSTGRES_PASSWORD=synthetic-phase3 -e POSTGRES_DB=pos postgres:18-alpine3.23 >/dev/null
ready=''
for i in $(seq 1 30); do if docker exec "$name" pg_isready -h 127.0.0.1 -U pos -d pos >/dev/null 2>&1; then ready=1; break; fi; sleep 0.25; done
test -n "$ready"
docker run --rm --network "container:$name" -e DB_HOST=127.0.0.1 -e DB_PORT=5432 -e DB_USER=pos -e DB_PASSWORD=synthetic-phase3 -e DB_NAME=pos -e SECRET_KEY=synthetic-phase3-signing-key-only-not-production -e REFRESH_SECRET_KEY=synthetic-phase3-refresh-key-only-not-production --entrypoint python "$image" -c "__PYTHON__"
'@
    $script.Replace('__PYTHON__', $python) | & ssh -o BatchMode=yes -o ConnectTimeout=10 gatlieros-vps "tr -d '\r' | bash"
    if ($LASTEXITCODE -ne 0) { throw 'VPS isolated regression run failed' }
    return
}

$root = Split-Path $PSScriptRoot -Parent
$name = 'scanaki-phase3-tests-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
try {
    & docker run -d --rm --name $name --network none --tmpfs /tmp:rw,size=512m -e PGDATA=/tmp/pgdata -e POSTGRES_USER=pos -e POSTGRES_PASSWORD=synthetic-phase3 -e POSTGRES_DB=pos postgres:18-alpine3.23 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL failed to start' }
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        & docker exec $name pg_isready -h 127.0.0.1 -U pos -d pos *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Disposable database unavailable' }
    & docker run --rm --network "container:$name" -v "${root}\back:/app:ro" -e DB_HOST=127.0.0.1 -e DB_PORT=5432 -e DB_USER=pos -e DB_PASSWORD=synthetic-phase3 -e DB_NAME=pos -e SECRET_KEY=synthetic-phase3-signing-key-only-not-production -e REFRESH_SECRET_KEY=synthetic-phase3-refresh-key-only-not-production --entrypoint python pos-back:latest -c $python
    if ($LASTEXITCODE -ne 0) { throw 'Local isolated regression run failed' }
} finally {
    & docker rm -f -v $name *> $null
}
