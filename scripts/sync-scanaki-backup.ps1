# Copies encrypted database and recovery backups; the heartbeat confirms cloud delivery separately.
$ErrorActionPreference = 'Stop'
$destination = 'G:\My Drive\Scanaki\Backup'
$scratch = Join-Path (Split-Path $PSScriptRoot -Parent) 'tmp\offsite-backup'
$mutex = [Threading.Mutex]::new($false, 'Local\ScanakiOffsiteBackup')
$locked = $false
function Transfer-CheckedFile([string]$remote, [string]$name, [string]$folder) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $local = Join-Path $scratch ($name + '.partial')
    $checksum = Join-Path $scratch ($name + '.sha256.partial')
    foreach ($item in @(@{ Source = $remote; Target = $local }, @{ Source = ($remote + '.sha256'); Target = $checksum })) {
        $ok = $false
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $sourcePath = 'gatlieros-vps:' + $item.Source
            $targetPath = $item.Target
            & scp -o BatchMode=yes -o ConnectTimeout=10 $sourcePath $targetPath
            if ($LASTEXITCODE -eq 0) { $ok = $true; break }
            if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
        }
        if (-not $ok) { throw 'Encrypted offsite transfer failed after three attempts' }
    }
    $line = (Get-Content -LiteralPath $checksum -Raw).Trim()
    if ($line -notmatch ('^([a-fA-F0-9]{64}) [ *]' + [regex]::Escape($name) + '$')) { throw 'Invalid checksum or filename' }
    $expected = $Matches[1]
    if ((Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -ine $expected) { throw 'VPS transfer checksum mismatch' }
    $target = Join-Path $folder $name
    if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $expected) { throw 'Existing Drive backup differs; refusing overwrite' }
    } else {
        $pending = $target + '.partial'
        Copy-Item -LiteralPath $local -Destination $pending
        if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash -ine $expected) { throw 'Drive staging checksum mismatch' }
        Move-Item -LiteralPath $pending -Destination $target
    }
    $pendingChecksum = $target + '.sha256.partial'
    Copy-Item -LiteralPath $checksum -Destination $pendingChecksum
    Move-Item -LiteralPath $pendingChecksum -Destination ($target + '.sha256') -Force
}
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another offsite copy is already running' }
    if (-not (Test-Path -LiteralPath 'G:\My Drive\Scanaki')) { throw 'Approved Drive mount unavailable' }
    New-Item -ItemType Directory -Force -Path $scratch, $destination | Out-Null
    $names = @(& ssh -o BatchMode=yes -o ConnectTimeout=10 gatlieros-vps 'find /opt/scanaki/app/backups/scanaki -maxdepth 1 -type f -name "scanaki_*.sql.gz.enc" -printf "%f\n" | sort | tail -1; find /opt/scanaki/app/backups/recovery -mindepth 1 -maxdepth 1 -type d -name "scanaki_recovery_*" -printf "%f\n" | sort | tail -1')
    if ($LASTEXITCODE -ne 0 -or $names.Count -ne 2) { throw 'Could not identify complete VPS backup set' }
    $db = $names[0].Trim()
    $bundle = $names[1].Trim()
    if ($db -notmatch '^scanaki_([0-9]{8}_[0-9]{6})\.sql\.gz\.enc$') { throw 'Invalid database backup name' }
    $dbStamp = $Matches[1]
    if ($bundle -notmatch '^scanaki_recovery_([0-9]{8}_[0-9]{6})_[a-f0-9]{12}$') { throw 'Invalid recovery bundle name' }
    foreach ($stamp in @($dbStamp, $Matches[1])) {
        $created = [DateTime]::ParseExact($stamp, 'yyyyMMdd_HHmmss', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        $age = [DateTime]::UtcNow - $created
        if ($age.TotalHours -gt 24 -or $age.TotalMinutes -lt -5) { throw 'Backup stale or timestamp in future' }
    }
    Transfer-CheckedFile "/opt/scanaki/app/backups/scanaki/$db" $db $destination
    Transfer-CheckedFile "/opt/scanaki/app/backups/recovery/$bundle/bundle.tar.enc" 'bundle.tar.enc' (Join-Path $destination $bundle)
    @{ checkedAtUtc = [DateTime]::UtcNow.ToString('o'); database = $db; recoveryBundle = $bundle; cloudVerified = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $scratch 'last-transfer.json')
    Write-Output "PASS encrypted database and recovery bundle copied with verified checksums. Recovery set: $bundle. Cloud confirmation remains separate."
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
