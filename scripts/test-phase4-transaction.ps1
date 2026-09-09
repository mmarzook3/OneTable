param([ValidateSet('local','vps')][string]$Target='local', [switch]$CleanupOnly, [string]$Checkpoint)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$tmpRoot = [IO.Path]::GetFullPath((Join-Path $root 'tmp'))
# Reject links/junctions in the entire parent chain before creating or reading journals.
function Assert-CheckpointPath([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Checkpoint path must not contain links or junctions' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
Assert-CheckpointPath $tmpRoot
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
if (!$Checkpoint) { $Checkpoint = Join-Path $root ('tmp/phase4-recovery-' + [guid]::NewGuid().ToString('N') + '.json') }
if (![IO.Path]::IsPathRooted($Checkpoint)) { $Checkpoint = Join-Path $root $Checkpoint }
$Checkpoint = [IO.Path]::GetFullPath($Checkpoint)
$comparison = if ($env:OS -eq 'Windows_NT') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
if (!$Checkpoint.StartsWith($tmpRoot + [IO.Path]::DirectorySeparatorChar, $comparison) -or
    [IO.Path]::GetExtension($Checkpoint) -ne '.json' -or $Checkpoint.Substring($tmpRoot.Length).Contains(':')) {
    throw 'Checkpoint must be a JSON file inside project tmp'
}
Assert-CheckpointPath $Checkpoint
$helper = '/tmp/phase4-transaction-fixture.py'
if ($Target -eq 'local') {
    docker cp scripts/phase4-transaction-fixture.py "pos-back:$helper"
} else {
    ssh -o BatchMode=yes gatlieros-vps 'mkdir -p /opt/scanaki/app/tmp'
    if ($LASTEXITCODE -ne 0) { throw 'Fixture staging unavailable' }
    scp scripts/phase4-transaction-fixture.py gatlieros-vps:/opt/scanaki/app/tmp/phase4-transaction-fixture.py
    if ($LASTEXITCODE -ne 0) { throw 'Fixture helper upload failed' }
    ssh -o BatchMode=yes gatlieros-vps "docker cp /opt/scanaki/app/tmp/phase4-transaction-fixture.py scanaki-back:$helper"
}
if ($LASTEXITCODE -ne 0) { throw 'Fixture helper upload failed' }
$state = $null
if ($CleanupOnly) {
    $state = Get-Content -LiteralPath $Checkpoint -Raw
    $identity = $state | ConvertFrom-Json
    if ($identity.target -and $identity.target -ne $Target) { throw 'Recovery target mismatch' }
} else {
    if (Test-Path -LiteralPath $Checkpoint) { throw 'Refusing to overwrite recovery checkpoint' }
    if ($Target -eq 'local') {
        $prepared = docker exec -e PYTHONPATH=/app pos-back python $helper prepare --execute --allow-synthetic
    } else {
        $prepared = ssh -o BatchMode=yes gatlieros-vps "docker exec -e PYTHONPATH=/app scanaki-back python $helper prepare --execute --allow-synthetic"
    }
    if ($LASTEXITCODE -ne 0) { throw 'Fixture preparation failed' }
    $identity = ($prepared -join "`n") | ConvertFrom-Json
    $state = @{synthetic=$identity.synthetic;nonce=$identity.nonce;marker=$identity.marker;deviceKey=$identity.deviceKey;protected=$identity.protected;target=$Target} | ConvertTo-Json
    # Durable, exclusive creation precedes every seed mutation. No credentials in this journal.
    $stream = [IO.File]::Open($Checkpoint, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($state)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}
$testExit = 0
try {
    if (!$CleanupOnly) {
        if ($Target -eq 'local') {
            $private = $state | docker exec -i -e PYTHONPATH=/app pos-back python $helper seed --recovery-stdin --execute --allow-synthetic
        } else {
            $private = $state | ssh -o BatchMode=yes gatlieros-vps "docker exec -i -e PYTHONPATH=/app scanaki-back python $helper seed --recovery-stdin --execute --allow-synthetic"
        }
        if ($LASTEXITCODE -ne 0) { throw 'Fixture seed failed; recovery identity retained' }
        try { $f = ($private -join "`n") | ConvertFrom-Json } catch { throw 'Invalid private seed response' }
        if ($f.nonce -ne $identity.nonce -or $f.marker -ne $identity.marker -or !$f.token -or !$f.tableToken) { throw 'Private seed identity mismatch' }
        $base = if ($Target -eq 'local') { 'http://haproxy:4202/' } else { 'https://scanaki.uk/' }
        $flags = @('--execute','--allow-synthetic')
        if ($Target -eq 'vps') { $flags += '--allow-remote-synthetic' }
        $report = $private | docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.test.yml run --rm -T -e "BASE_URL=$base" -v "${root}/front/scripts/test-phase4-transaction.mjs:/app/scripts/test-phase4-transaction.mjs:ro" browser-test node scripts/test-phase4-transaction.mjs @flags
        $testExit = $LASTEXITCODE
        $report | Set-Content "tmp/phase4-transaction-$Target.json" -Encoding utf8
        Write-Output $report
    }
} finally {
    if ($Target -eq 'local') {
        $clean = $state | docker exec -i -e PYTHONPATH=/app pos-back python $helper cleanup --execute --allow-synthetic
    } else {
        $clean = $state | ssh -o BatchMode=yes gatlieros-vps "docker exec -i -e PYTHONPATH=/app scanaki-back python $helper cleanup --execute --allow-synthetic"
    }
    if ($LASTEXITCODE -ne 0) { throw "Cleanup failed; retain recovery checkpoint: $Checkpoint" }
    $clean | Set-Content "tmp/phase4-transaction-$Target-cleanup.json" -Encoding utf8
    Write-Output $clean
    $private = $null
}
if ($testExit -ne 0) { throw 'Transaction rehearsal failed; cleanup completed' }
