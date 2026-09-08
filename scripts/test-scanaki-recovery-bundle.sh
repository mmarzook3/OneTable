#!/usr/bin/env bash
# Synthetic fixtures only. Requires existing bash, python3 and openssl.
set -euo pipefail
set +x
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RECOVERY_SCRIPT="$SCRIPT_DIR/scanaki-recovery-bundle.sh"
exec python3 - <<'PY'
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

script = Path(os.environ['RECOVERY_SCRIPT'])
scratch = script.parent.parent / 'tmp'
scratch.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='recovery-test-', dir=scratch) as name:
    root = Path(name)
    env = dict(os.environ, SCANAKI_APP_DIR=str(root),
               SCANAKI_BACKUP_PASSPHRASE='synthetic-recovery-fixture-passphrase')
    env.pop('SCANAKI_BACKUP_DIR', None)
    def run(*args, success=True):
        result = subprocess.run(['bash', str(script), *args], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == success, 'Unexpected operation result'
        return result.stdout.strip()
    def checksum(path):
        Path(str(path) + '.sha256').write_text(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n')
    for file in ('config.env', 'deployment-secrets.env', 'docker-compose.scanaki.yml',
                 'nginx.scanaki.conf', 'release-commit.txt'):
        (root / file).write_text('synthetic fixture only\n')
    uploads = root / 'data/uploads'
    uploads.mkdir(parents=True)
    (uploads / 'sample.txt').write_text('synthetic upload\n')
    (root / 'ops.env').write_text('excluded synthetic key file\n')
    backups = root / 'backups/scanaki'
    backups.mkdir(parents=True)
    sql = backups / 'scanaki_20260908_020000.sql.gz.enc'
    sql.write_bytes(b'synthetic opaque encrypted SQL fixture')
    checksum(sql)
    bundle = Path(run('create'))
    assert bundle.stat().st_mode & 0o777 == 0o600
    assert bundle.parent.stat().st_mode & 0o777 == 0o700
    assert Path(str(bundle) + '.sha256').stat().st_mode & 0o777 == 0o600
    run('rehearse', str(bundle))
    Path(str(sql) + '.sha256').unlink()
    run('create', success=False)
    checksum(sql)
    sql.write_bytes(b'changed')
    run('create', success=False)
    checksum(sql)
    (uploads / 'escape').symlink_to(root / 'ops.env')
    run('create', success=False)
    (uploads / 'escape').unlink()
    (root / 'config.env').unlink()
    run('create', success=False)
    (root / 'config.env').write_text('synthetic\n')
    original = bundle.read_bytes()
    bundle.write_bytes(original + b'tampered')
    run('rehearse', str(bundle), success=False)
    bundle.write_bytes(original)
    env['SCANAKI_BACKUP_PASSPHRASE'] = 'wrong-synthetic-fixture-passphrase'
    run('rehearse', str(bundle), success=False)
    env['SCANAKI_BACKUP_PASSPHRASE'] = 'synthetic-recovery-fixture-passphrase'
    # Decrypt only our synthetic fixture to prove the allowlist.
    plain = root / 'fixture.tar'
    subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000',
                    '-pass', 'env:SCANAKI_BACKUP_PASSPHRASE', '-in', str(bundle), '-out', str(plain)],
                   env=env, check=True, capture_output=True)
    with tarfile.open(plain) as archive:
        assert 'ops.env' not in archive.getnames()
        assert 'data/uploads/sample.txt' in archive.getnames()
    for kind in ('traversal', 'symlink'):
        with tarfile.open(plain, 'w') as archive:
            entry = tarfile.TarInfo('../outside' if kind == 'traversal' else 'data/uploads/link')
            if kind == 'symlink':
                entry.type = tarfile.SYMTYPE
                entry.linkname = '/etc/passwd'
            archive.addfile(entry)
        hostile = root / 'hostile.enc'
        subprocess.run(['openssl', 'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000',
                        '-pass', 'env:SCANAKI_BACKUP_PASSPHRASE', '-in', str(plain), '-out', str(hostile)],
                       env=env, check=True, capture_output=True)
        checksum(hostile)
        run('rehearse', str(hostile), success=False)
    assert not list((root / 'tmp/scanaki-recovery').iterdir()), 'Scratch not cleaned'
    print('PASS synthetic bundle roundtrip, permissions, allowlist, missing/mismatched checksums, missing config, symlinks, tampering, wrong key, hostile archives and cleanup')
PY
