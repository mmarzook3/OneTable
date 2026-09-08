#!/usr/bin/env bash
# Usage: SCANAKI_APP_DIR=... SCANAKI_BACKUP_PASSPHRASE=... bash "$0" create
#        ... bash "$0" rehearse /absolute/path/to/bundle.tar.enc
# Requires Python 3 and OpenSSL; never sources configuration or contacts services.
# All allowlisted inputs are required. Symlinks (including internal ones) are refused.
# This is file integrity rehearsal, NOT full application recovery or rollback proof.
set -euo pipefail
set +x
umask 077
exec python3 - "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from datetime import datetime, timezone

CONFIG = ('config.env', 'deployment-secrets.env', 'docker-compose.scanaki.yml',
          'nginx.scanaki.conf', 'release-commit.txt')
SQL = re.compile(r'scanaki_[0-9]{8}_[0-9]{6}\.sql\.gz\.enc')

def require(ok):
    if not ok:
        raise ValueError('Recovery validation failed')

def safe(path):
    path = Path(os.path.abspath(path))
    for part in (*reversed(path.parents), path):
        require(not part.is_symlink())
    return path

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def verify(path):
    safe(path)
    side = safe(Path(str(path) + '.sha256'))
    require(path.is_file() and side.is_file())
    # Parse rather than execute checksum filenames supplied by an external file.
    value = side.read_text().strip()
    match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *]' + re.escape(path.name), value)
    require(match is not None and digest(path) == match[1].lower())

def private_dir(path):
    safe(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(path.is_dir())
    path.chmod(0o700)
    return path

def crypt(source, target, decrypt=False):
    command = ['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000',
               '-pass', 'env:SCANAKI_BACKUP_PASSPHRASE', '-in', str(source),
               '-out', str(target)]
    command += ['-d'] if decrypt else ['-salt']
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target.chmod(0o600)

def allowed(name):
    parts = name.split('/')
    if any(p in ('', '.', '..') for p in parts):
        return False
    return (name in CONFIG or name == 'data/uploads' or name.startswith('data/uploads/')
            or name == 'manifest.json'
            or (len(parts) == 2 and parts[0] == 'database'
                and SQL.fullmatch(parts[1].removesuffix('.sha256')) is not None))

def run():
    require(len(sys.argv) >= 2)
    mode = sys.argv[1]
    require((mode == 'create' and len(sys.argv) == 2)
            or (mode == 'rehearse' and len(sys.argv) == 3))
    require(len(os.environ.get('SCANAKI_BACKUP_PASSPHRASE', '')) >= 20)
    root = safe(Path(os.environ.get('SCANAKI_APP_DIR', '/opt/scanaki/app')))
    require(root.is_dir())
    scratch = private_dir(root / 'tmp' / 'scanaki-recovery')
    with tempfile.TemporaryDirectory(prefix='work-', dir=scratch) as work_name:
        work = Path(work_name)
        archive = work / 'payload.tar'
        if mode == 'create':
            backup = safe(Path(os.environ.get('SCANAKI_BACKUP_DIR', str(root / 'backups/scanaki'))))
            candidates = sorted(p for p in backup.iterdir() if SQL.fullmatch(p.name))
            require(bool(candidates))
            sql = candidates[-1]
            verify(sql)
            uploads = safe(root / 'data/uploads')
            require(uploads.is_dir())
            entries = [(safe(root / name), name) for name in CONFIG]
            require(all(p.is_file() for p, _ in entries))
            entries.append((uploads, 'data/uploads'))
            for current, dirs, files in os.walk(uploads, followlinks=False):
                for name in sorted(dirs + files):
                    path = safe(Path(current) / name)
                    require(path.is_dir() or path.is_file())
                    entries.append((path, path.relative_to(root).as_posix()))
            entries += [(sql, 'database/' + sql.name),
                        (Path(str(sql) + '.sha256'), 'database/' + sql.name + '.sha256')]
            # Stage copies first; the archive manifest describes exactly these bytes.
            stage = private_dir(work / 'stage')
            hashes = {}
            directories = []
            for source, name in entries:
                safe(source)
                target = stage / name
                if source.is_dir():
                    private_dir(target)
                    directories.append(name)
                else:
                    require(stat.S_ISREG(source.lstat().st_mode))
                    private_dir(target.parent)
                    with source.open('rb') as src, target.open('xb') as dst:
                        shutil.copyfileobj(src, dst)
                    target.chmod(0o600)
                    hashes[name] = digest(target)
            verify(stage / 'database' / sql.name)
            manifest = {'version': 1, 'files': hashes, 'directories': directories,
                        'database': 'database/' + sql.name,
                        'scope': 'file-integrity-only; not application rollback proof'}
            (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True))
            with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
                for name in sorted([*hashes, *directories, 'manifest.json']):
                    tar.add(stage / name, arcname=name, recursive=False)
            output = private_dir(root / 'backups/recovery')
            identity = 'scanaki_recovery_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S') + '_' + uuid.uuid4().hex[:12]
            pending = private_dir(work / 'publish')
            encrypted = pending / 'bundle.tar.enc'
            crypt(archive, encrypted)
            (pending / 'bundle.tar.enc.sha256').write_text(digest(encrypted) + '  bundle.tar.enc\n')
            # One rename publishes both encrypted payload and checksum, or neither.
            os.rename(pending, output / identity)
            print(str(output / identity / 'bundle.tar.enc'))
        else:
            encrypted = safe(Path(sys.argv[2]))
            verify(encrypted)
            crypt(encrypted, archive, decrypt=True)
            extracted = private_dir(work / 'extracted')
            seen = set()
            with tarfile.open(archive, 'r:') as tar:
                for member in tar:
                    require(allowed(member.name) and member.name not in seen)
                    require(member.isfile() or member.isdir())
                    seen.add(member.name)
                    target = extracted / member.name
                    if member.isdir():
                        require(member.name == 'data/uploads' or member.name.startswith('data/uploads/'))
                        private_dir(target)
                    else:
                        private_dir(target.parent)
                        with tar.extractfile(member) as src, target.open('xb') as dst:
                            shutil.copyfileobj(src, dst)
                        target.chmod(0o600)
            manifest = json.loads((extracted / 'manifest.json').read_text())
            require(manifest['version'] == 1)
            files, directories = manifest['files'], manifest['directories']
            require(set(files).isdisjoint(directories))
            require(seen == set(files) | set(directories) | {'manifest.json'})
            require(set(CONFIG).issubset(files) and 'data/uploads' in directories)
            database = manifest['database']
            require(database.startswith('database/') and SQL.fullmatch(database[9:]) is not None)
            require(database in files and database + '.sha256' in files)
            for name, expected in files.items():
                require(allowed(name) and (extracted / name).is_file())
                require(digest(extracted / name) == expected)
            for name in directories:
                require(allowed(name) and (extracted / name).is_dir())
            verify(extracted / database)
            print('PASS isolated decrypt/extract integrity; NOT full app recovery or rollback proof')

try:
    run()
except Exception:
    # Never emit paths from archives, configuration contents or subprocess errors.
    print('FAIL recovery bundle operation; inputs, integrity or prerequisites invalid', file=sys.stderr)
    sys.exit(1)
PY
