#!/usr/bin/python3
"""Installed independently by an operator; uploaded releases cannot replace this code."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path('/opt/projects/scanaki')
STATE = Path('/var/lib/scanaki-home-deploy')
APPS = ('back', 'front', 'ws-bridge')
SERVICES = set(APPS) | {'db', 'redis'}


def run(*args, capture=False):
    return subprocess.run(args, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def image_name(service, sha):
    return f'scanaki-home-release-{service}:{sha}'


def validate_archive(path, sha):
    # Reject extra tags before docker load can overwrite any unrelated project image.
    with tarfile.open(path, 'r:') as archive:
        entries = archive.getmembers()
        if any(m.name.startswith('/') or '..' in Path(m.name).parts or
               not (m.isfile() or m.isdir()) for m in entries):
            raise ValueError('Unsafe image archive members')
        manifests = [m for m in entries if m.name == 'manifest.json']
        if len(manifests) != 1 or manifests[0].size > 1024**2:
            raise ValueError('Missing or oversized Docker manifest')
        manifest = json.load(archive.extractfile(manifests[0]))
        expected = {image_name(s, sha) for s in APPS}
        tags = [tag for item in manifest for tag in item.get('RepoTags', [])]
        if len(manifest) != 3 or len(tags) != 3 or set(tags) != expected:
            raise ValueError('Archive must contain exactly the three revision-tagged app images')


def next_config(config, sha, runtime_users):
    if set(config.get('services', {})) != SERVICES:
        raise ValueError('Expected the five HOME services')
    result = copy.deepcopy(config)
    for service in APPS:
        if 'build' in result['services'][service]:
            raise ValueError('HOME compose must be image-only')
        result['services'][service]['image'] = image_name(service, sha)
        if 'user' not in result['services'][service] and runtime_users[service]:
            result['services'][service]['user'] = runtime_users[service]
    # All private commands, environment, extra_hosts, mounts and networks stay intact.
    return result


def validate_runtime_user(service, settings, container):
    current = run('docker', 'exec', container, '/bin/sh', '-c', 'id -u; id -g', capture=True).strip()
    args = ['docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']
    if settings.get('user') is not None:
        args += ['--user', str(settings['user'])]
    check = 'id -u; id -g; '
    if service == 'front':
        check += 'test -r /usr/share/nginx/html/index.html && test -x /usr/sbin/nginx'
    else:
        source = '/app/app/main.py' if service == 'back' else '/app/main.py'
        check += f'test -r {source} && PYTHONDONTWRITEBYTECODE=1 python -c "import fastapi, uvicorn, sqlmodel"'
    actual = run(*args, '--entrypoint', '/bin/sh', settings['image'], '-ec', check, capture=True).strip()
    # Names may resolve to different IDs in the new image. Never silently change identity.
    if not re.fullmatch(r'[0-9]+\n[0-9]+', current) or actual != current:
        raise ValueError('Candidate runtime UID/GID differs from current container: ' + service)


def probe():
    for path in ('/', '/api/health'):
        with urllib.request.urlopen('http://127.0.0.1:28420' + path, timeout=10) as response:
            if response.status != 200:
                raise ValueError('HOME HTTP probe failed')


def deploy(sha, release):
    compose = ROOT / 'compose.json'
    original = compose.read_bytes()
    config = json.loads(original)
    command = ['docker', 'compose', '--project-directory', str(ROOT),
               '-p', 'scanaki-home', '-f', str(compose)]
    def dc(*args, capture=False):
        return run(*command, *args, capture=capture)
    def healthy():
        inspected = {}
        for service in SERVICES:
            container = dc('ps', '-q', service, capture=True).strip()
            if not container:
                raise ValueError('Missing HOME service')
            data = json.loads(run('docker', 'inspect', container, capture=True))[0]
            if data['State'].get('Health', {}).get('Status') != 'healthy':
                raise ValueError('HOME service not healthy: ' + service)
            inspected[service] = (container, data)
        return inspected
    current = healthy()
    runtime_users = {s: current[s][1]['Config']['User'] for s in APPS}
    candidate = next_config(config, sha, runtime_users)
    probe()
    if shutil.disk_usage(ROOT).free < 8 * 1024**3:
        raise ValueError('Need at least 8 GiB free before image load/backup')
    archive = release / 'images.tar'
    with archive.open('rb') as source:
        hasher = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024**2), b''):
            hasher.update(chunk)
        digest = hasher.hexdigest()
    if digest != (release / 'digest').read_text():
        raise ValueError('Staged archive changed')
    validate_archive(archive, sha)
    run('docker', 'load', '-i', str(archive))
    for service in APPS:
        data = json.loads(run('docker', 'image', 'inspect', image_name(service, sha), capture=True))[0]
        labels = data['Config'].get('Labels') or {}
        if labels.get('org.opencontainers.image.revision') != sha or labels.get('org.opencontainers.image.source') != 'https://github.com/mmarzook3/OneTable':
            raise ValueError('Image source/revision does not match approved repository')
        if data['Os'] != 'linux' or data['Architecture'] != 'amd64':
            raise ValueError('Expected linux/amd64 image')
        validate_runtime_user(service, candidate['services'][service], current[service][0])
    # Backup service must complete a NEW invocation successfully, not an already-running one.
    if run('systemctl', 'show', '-p', 'ActiveState', '--value', 'scanaki-home-backup.service', capture=True).strip() not in ('inactive', 'failed'):
        raise ValueError('Backup already running; retry after operator review')
    before = run('systemctl', 'show', '-p', 'ExecMainStartTimestampMonotonic', '--value', 'scanaki-home-backup.service', capture=True).strip()
    run('systemctl', 'start', 'scanaki-home-backup.service')
    after = run('systemctl', 'show', '-p', 'ExecMainStartTimestampMonotonic', '--value', 'scanaki-home-backup.service', capture=True).strip()
    if not after or after == '0' or before == after or run('systemctl', 'show', '-p', 'Result', '--value', 'scanaki-home-backup.service', capture=True).strip() != 'success':
        raise ValueError('Fresh native backup not verified')
    if compose.read_bytes() != original:
        raise ValueError('HOME compose changed during preparation')
    shutil.copy2(compose, release / 'compose.before.json')
    # Private bind sources are included by the native backup; snapshot compose before mutations.
    staged = ROOT / '.compose.home-deploy.json'
    staged.write_text(json.dumps(candidate, indent=2) + '\n')
    os.chmod(staged, 0o600)
    run('docker', 'compose', '--project-directory', str(ROOT), '-p', 'scanaki-home', '-f', str(staged), 'config', '--quiet')
    # Refuse unreviewed external configuration edits during backup/preparation.
    if compose.read_bytes() != (release / 'compose.before.json').read_bytes():
        raise ValueError('HOME compose changed during preparation')
    # Persist BEFORE any live mutation, so a process/host crash also fails closed.
    (STATE / 'recovery-required').write_text(sha + '\n')
    (release / 'status').write_text('mutating\n')
    # Stop ALL application writers before migration; db/redis/relay are untouched.
    dc('stop', *APPS)
    os.replace(staged, compose)
    # Preserve private entrypoint/runtime for normal startup; bypass it ONLY for migrations.
    dc('run', '--rm', '--no-deps', '--entrypoint', 'python', 'back', '-m', 'app.migrate')
    dc('run', '--rm', '--no-deps', '--entrypoint', 'python', 'back', '-m', 'app.migrate', '--sync-idempotent')
    dc('up', '-d', '--no-deps', '--no-build', '--pull', 'never', *APPS)
    for attempt in range(30):
        try:
            healthy()
            probe()
            break
        except Exception:
            if attempt == 29:
                raise
            time.sleep(5)
    for service in APPS:
        container = dc('ps', '-q', service, capture=True).strip()
        actual = json.loads(run('docker', 'inspect', container, capture=True))[0]['Image']
        expected = json.loads(run('docker', 'image', 'inspect', image_name(service, sha), capture=True))[0]['Id']
        if actual != expected:
            raise ValueError('Running container image does not match release')
    logs = dc('logs', '--since', '5m', '--tail', '120', *APPS, capture=True)
    # Keep private runtime output on HOME only.
    (release / 'container.log').write_text(logs)
    if re.search(r'application bundle generation failed|traceback|fatal|uncaught exception', logs, re.I):
        raise ValueError('Recent application logs contain errors')
    (release / 'status').write_text('succeeded\n')
    (STATE / 'recovery-required').unlink()
    # Docker already owns the loaded layers; retain tags and all rollback metadata.
    (release / 'images.tar').unlink(missing_ok=True)


def main():
    os.umask(0o077)
    sha = sys.argv[1]
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Invalid revision')
    import fcntl
    release = STATE / sha
    with (STATE / 'deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (STATE / 'latest').read_text() != sha:
            if (release / 'status').read_text().strip() == 'queued':
                (release / 'status').write_text('superseded\n')
                (release / 'images.tar').unlink(missing_ok=True)
            return
        # An unresolved failed mutation requires operator recovery before ANY next release.
        if (STATE / 'recovery-required').exists():
            (release / 'status').write_text('blocked\n')
            return
        (release / 'status').write_text('preparing\n')
        try:
            deploy(sha, release)
        except Exception:
            if (release / 'status').read_text().strip() == 'mutating':
                (STATE / 'recovery-required').write_text(sha + '\n')
            (release / 'status').write_text('failed\n')
            # No automatic DB downgrade or stale image restart after possible schema mutation.
            raise


if __name__ == '__main__':
    main()
