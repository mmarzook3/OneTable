#!/usr/bin/python3
"""Root-owned forced-command receiver. Never execute commands from the SSH client."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path('/var/lib/scanaki-home-deploy')
MAX_BYTES = 4 * 1024**3


def parse(command):
    match = re.fullmatch(r'(submit|status) ([0-9a-f]{40})(?: ([0-9a-f]{64}))?', command)
    if not match or (match[1] == 'submit') != bool(match[3]):
        raise ValueError('Expected submit SHA SHA256 or status SHA')
    return match.groups()


def main():
    os.umask(0o077)
    action, sha, digest = parse(sys.argv[1] if len(sys.argv) == 2 else '')
    release = ROOT / sha
    if action == 'status':
        status = release / 'status'
        print(status.read_text().strip() if status.exists() else 'unknown')
        return
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Serialize upload/submission; deployment has a separate systemd-owned lock.
    import fcntl
    with (ROOT / 'receive.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if release.exists():
            raise ValueError('Revision already submitted; inspect status, never replace it')
        temporary = Path(tempfile.mkdtemp(prefix='.receive-', dir=ROOT))
        try:
            if shutil.disk_usage(ROOT).free < MAX_BYTES + 2 * 1024**3:
                raise ValueError('Insufficient staging disk space')
            hasher = hashlib.sha256()
            size = 0
            with (temporary / 'images.tar').open('wb') as output:
                while chunk := sys.stdin.buffer.read(1024**2):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError('Image archive exceeds limit')
                    hasher.update(chunk)
                    output.write(chunk)
            if not size or hasher.hexdigest() != digest:
                raise ValueError('Incomplete or mismatched image archive')
            (temporary / 'digest').write_text(digest)
            (temporary / 'status').write_text('queued\n')
            temporary.rename(release)
            latest = ROOT / '.latest'
            latest.write_text(sha)
            latest.replace(ROOT / 'latest')
            try:
                subprocess.run(['systemctl', 'start', '--no-block',
                                f'scanaki-home-deploy@{sha}.service'], check=True)
            except Exception:
                (release / 'status').write_text('failed\n')
                raise
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    print('queued')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
