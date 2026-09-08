# Copy the latest encrypted VPS backup to the approved Drive-mounted folder.
# Requires this laptop, SSH and Google Drive for desktop to be available.
$ErrorActionPreference = 'Stop'
$destination = 'G:\My Drive\Scanaki\Backup'
$scratch = Join-Path (Split-Path $PSScriptRoot -Parent) 'tmp\offsite-backup'
if (-not (Test-Path -LiteralPath 'G:\My Drive\Scanaki')) { throw 'Approved Drive mount unavailable' }
$name = (& ssh -o BatchMode=yes -o ConnectTimeout=10 gatlieros-vps 'find /opt/scanaki/app/backups/scanaki -maxdepth 1 -type f -name "scanaki_*.sql.gz.enc" -printf "%f\n" | sort | tail -1').Trim()
if ($LASTEXITCODE -ne 0 -or $name -notmatch '^scanaki_[0-9]{8}_[0-9]{6}\.sql\.gz\.enc$') { throw 'No valid VPS backup name returned' }
New-Item -ItemType Directory -Force -Path $scratch, $destination | Out-Null
$local = Join-Path $scratch $name
$checksum = "$local.sha256"
& scp "gatlieros-vps:/opt/scanaki/app/backups/scanaki/$name" $local
if ($LASTEXITCODE -ne 0) { throw 'Encrypted backup transfer failed' }
& scp "gatlieros-vps:/opt/scanaki/app/backups/scanaki/$name.sha256" $checksum
if ($LASTEXITCODE -ne 0) { throw 'Checksum transfer failed' }
$expected = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0]
if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid checksum file' }
if ((Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -ine $expected) { throw 'VPS transfer checksum mismatch' }
$target = Join-Path $destination $name
if (Test-Path -LiteralPath $target) {
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $expected) { throw 'Existing Drive backup differs; refusing overwrite' }
} else {
    Copy-Item -LiteralPath $local -Destination $target
}
Copy-Item -LiteralPath $checksum -Destination "$target.sha256"
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $expected) { throw 'Drive mount checksum mismatch' }
Write-Output "PASS encrypted backup $name copied and checksum verified. Cloud synchronization must be checked separately."
