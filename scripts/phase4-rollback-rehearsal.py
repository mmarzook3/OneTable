"""Guarded Scanaki rollback baseline and isolated image-replacement rehearsal.

Default is NOOP. No live cutover is authorized by running capture/rehearse.
Before FUTURE rollback: primary engineering operator pauses CI/manual deployments
(the CI rsync precedes the host lock), supplies expected CURRENT SHA and the
independently recorded baseline manifest SHA256, and reviews config/schema guards.
Example incident command after review:
  bash scripts/scanaki-rollback-baseline.sh rollback --execute \
    --expected-current-sha <CURRENT_40_HEX> --baseline-sha256 <RECORDED_64_HEX> \
    --deployments-paused --allow-live-cutover
Schema/config mismatch requires a new reviewed recovery plan, never DB downgrade.
Failures stop, retain a journal, and require escalation to alerts@scanaki.uk.
No automatic reversal or database operation is attempted after partial failure.
Human final GO and physical acceptance are separate. Isolated rehearsal proves
Compose replacement/pins, NOT application/browser/database compatibility.
"""
import argparse
import fcntl
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import uuid

ROOT = Path('/opt/scanaki/app')
SHA = 'd23e7e68e48cf1ae51064b117804d5a3f690f204'
RELEASE = Path('/opt/scanaki/releases') / SHA
IMAGES = {
    'back': 'sha256:9f601b9abd8157f39826a462fd624bec38b133b8ef9f3dbb7550bb2ca6ad980d',
    'front': 'sha256:fd5a647375165c29550f298fe632d318c69c0b129f0aed9480de9c6d0526bd8f',
}
SERVICES = ('back', 'front', 'ws-bridge')
BASE = ROOT / 'backups' / 'rollback-baselines' / SHA
CONFIG = ('config.env', 'deployment-secrets.env', 'docker-compose.scanaki.yml', 'nginx.scanaki.conf')
# Protect these during rsync as well as excluding them from retained source.
PROTECTED = ('.env', '.secrets', 'config.env', 'deployment-secrets.env',
             'docker-compose.scanaki.yml', 'nginx.scanaki.conf', 'data', 'backups',
             'tmp', 'certbot', '.git', 'android/scanaki-kitchen/signing', 'back/uploads')
BLOCKED_PARTS = {'node_modules', '__pycache__', '.venv', 'venv', '.secrets', '.git',
                 '.codex-remote-attachments', 'uploads', 'signing', 'backups', 'tmp', 'certbot'}
SECRET_PATTERNS = ('.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.jks', '*.keystore')


def secret_patterns():
    # Expand only original ASCII letters, never reprocess generated classes.
    return tuple(''.join('[' + c + c.upper() + ']' if 'a' <= c <= 'z' else c
                         for c in pattern) for pattern in SECRET_PATTERNS)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, 'Command failed; output withheld: ' + args[0])
    return result.stdout


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def safe_path(path, directory=False):
    require(path.is_absolute() and path.resolve() == path, 'Symlink or noncanonical path refused')
    require(path.is_dir() if directory else path.is_file(), 'Required regular path missing')
    if not directory:
        require(stat.S_ISREG(path.stat().st_mode) and path.stat().st_nlink == 1, 'Nonregular/hardlinked file refused')
    return path


def allowed(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or not p.parts or str(p) != name:
        return False
    if any(name == x or name.startswith(x + '/') for x in PROTECTED):
        return False
    if any(x in BLOCKED_PARTS for x in p.parts):
        return False
    return not any(fnmatch.fnmatchcase(x, pattern) for x in p.parts for pattern in secret_patterns())


def rsync_protections():
    # Excludes protect the receiver from --delete as well as excluding the sender.
    # Basename patterns apply at every depth, including excluded directories.
    patterns = ['/' + p for p in PROTECTED] + sorted(BLOCKED_PARTS) + list(secret_patterns())
    return [arg for pattern in patterns for arg in ('--exclude', pattern)]


def config_hashes():
    paths = [ROOT / name for name in CONFIG] + [Path('/etc/scanaki/ops.env')]
    return {str(path): digest(safe_path(path)) for path in paths}


def schema_hash():
    data = run('docker', 'exec', 'scanaki-db', 'sh', '-c',
               'exec pg_dump --schema-only --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"')
    data = b'\n'.join(x for x in data.splitlines() if not x.startswith((b'\\restrict ', b'\\unrestrict ')))
    return hashlib.sha256(data).hexdigest()


def current_sha(expected):
    require(re.fullmatch(r'[0-9a-f]{40}', expected or ''), 'Explicit expected current SHA required')
    marker = safe_path(ROOT / 'release-commit.txt')
    require(marker.stat().st_size <= 128 and marker.read_text().strip() == expected, 'Current release mismatch')


def running_images():
    images = {}
    for service in SERVICES:
        info = json.loads(run('docker', 'inspect', 'scanaki-' + service))[0]
        require(info['State']['Running'], 'Application service is not running')
        require(info['Config']['Labels'].get('com.docker.compose.service') == service, 'Unexpected service ownership')
        require(info['Config']['Labels'].get('com.docker.compose.project') == 'scanaki_prod', 'Unexpected Compose project')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', info['Image']), 'Invalid image ID')
        images[service] = info['Image']
    return images


def source_aliases():
    alias = RELEASE / 'agents'
    require(alias.is_symlink() and os.readlink(alias) in ('agents2', 'agents2/'), 'Only root agents -> agents2 or agents2/ alias is supported')
    target = safe_path(RELEASE / 'agents2', directory=True)
    require(alias.resolve() == target, 'Source alias escapes retained release')
    return {'agents': os.readlink(alias)}


def archive_source(target):
    safe_path(RELEASE, directory=True)
    aliases = source_aliases()
    require(safe_path(RELEASE / 'release-commit.txt').read_text().strip() == SHA, 'Retained source SHA mismatch')
    for required in ('scripts/deploy-scanaki-production.sh', 'back/app/main.py', 'front/package.json'):
        safe_path(RELEASE / required)
    with tarfile.open(target, 'w') as archive:
        for parent, dirs, files in os.walk(RELEASE, followlinks=False):
            if Path(parent) == RELEASE:
                dirs[:] = [d for d in dirs if d != 'agents']
            dirs[:] = sorted(d for d in dirs if allowed((Path(parent) / d).relative_to(RELEASE).as_posix()))
            for d in dirs:
                safe_path(Path(parent) / d, directory=True)
            for name in sorted(files):
                path = Path(parent) / name
                relative = path.relative_to(RELEASE).as_posix()
                if allowed(relative):
                    safe_path(path)
                    archive.add(path, arcname=relative, recursive=False)
    return aliases


def extract_source(archive_path, destination, aliases):
    # Only regular files, no implicit tar extraction or archive-controlled ownership.
    require(aliases in ({'agents': 'agents2'}, {'agents': 'agents2/'}), 'Unapproved source alias metadata')
    with tarfile.open(archive_path, 'r:') as archive:
        members = archive.getmembers()
        names = set()
        require(0 < len(members) < 100000, 'Invalid source archive count')
        require(sum(m.size for m in members) < 8 * 1024**3, 'Source archive too large')
        for member in members:
            require(member.isfile() and allowed(member.name) and member.name not in names,
                    'Unsafe/duplicate source archive member')
            require(member.name != 'agents' and not member.name.startswith('agents/'), 'Archive may not supply source alias path')
            names.add(member.name)
        require('release-commit.txt' in names, 'Source marker missing')
        for member in members:
            path = destination / member.name
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, path.open('xb') as out:
                shutil.copyfileobj(source, out)
            path.chmod(0o755 if member.mode & 0o111 else 0o644)
    require((destination / 'release-commit.txt').read_text().strip() == SHA, 'Archived source release mismatch')
    target = safe_path(destination / 'agents2', directory=True)
    require(target.resolve().is_relative_to(destination.resolve()), 'Extracted alias target escapes stage')
    (destination / 'agents').symlink_to(aliases['agents'], target_is_directory=True)


def capture(args):
    require(args.expected_current_sha == SHA, 'Capture only the verified baseline release')
    images = running_images()
    require(all(images[k] == v for k, v in IMAGES.items()), 'Verified baseline image mismatch')
    require(not BASE.exists(), 'Baseline exists; never overwrite')
    BASE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    safe_path(BASE.parent, directory=True)
    # On failure retain .pending-* for operator inspection; never publish it as valid.
    stage = Path(tempfile.mkdtemp(prefix='.pending-', dir=BASE.parent))
    manifest = {'release': SHA, 'images': images, 'config_hashes': config_hashes(),
                'schema_sha256': schema_hash(), 'archives': {}}
    manifest['source_aliases'] = archive_source(stage / 'source.tar')
    manifest['source_sha256'] = digest(stage / 'source.tar')
    for service, image in images.items():
        run('docker', 'image', 'save', '-o', str(stage / (service + '.tar')), image)
        manifest['archives'][service] = digest(stage / (service + '.tar'))
    # Detect external promotion/config/schema drift before publishing.
    current_sha(args.expected_current_sha)
    require(running_images() == images and config_hashes() == manifest['config_hashes']
            and schema_hash() == manifest['schema_sha256'], 'Baseline changed during capture')
    (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    stage.rename(BASE)
    print('Baseline captured. Record independently: manifest SHA256=' + digest(BASE / 'manifest.json'))


def baseline(args):
    safe_path(BASE, directory=True)
    require(re.fullmatch(r'[0-9a-f]{64}', args.baseline_sha256 or ''), 'Independently recorded baseline SHA256 required')
    require(digest(safe_path(BASE / 'manifest.json')) == args.baseline_sha256, 'Manifest checksum mismatch')
    manifest = json.loads((BASE / 'manifest.json').read_text())
    require(manifest['release'] == SHA and set(manifest['images']) == set(SERVICES), 'Baseline identity mismatch')
    require(manifest.get('source_aliases') in ({'agents': 'agents2'}, {'agents': 'agents2/'}), 'Missing or unapproved source alias metadata')
    require(all(manifest['images'][k] == v for k, v in IMAGES.items()), 'Pinned baseline mismatch')
    require(all(re.fullmatch(r'sha256:[0-9a-f]{64}', v) for v in manifest['images'].values()), 'Invalid image pins')
    require(config_hashes() == manifest['config_hashes'], 'Config mismatch; reviewed recovery required')
    require(schema_hash() == manifest['schema_sha256'], 'Schema mismatch; database downgrade forbidden')
    require(digest(safe_path(BASE / 'source.tar')) == manifest['source_sha256'], 'Source checksum mismatch')
    for service in SERVICES:
        require(digest(safe_path(BASE / (service + '.tar'))) == manifest['archives'][service], 'Image archive checksum mismatch')
    return manifest


def compose_live(overlay, *arguments):
    # Match production interpolation; never serialize the resolved config/secrets.
    return run('bash', '-c',
               'set -euo pipefail; cd /opt/scanaki/app; set -a; source deployment-secrets.env; '
               'source /etc/scanaki/ops.env; set +a; exec docker compose --project-name scanaki_prod '
               '--env-file config.env -f docker-compose.scanaki.yml -f "$@"',
               'rollback', str(overlay), *arguments)


def app_replace(overlay):
    compose_live(overlay, 'config', '--quiet')
    compose_live(overlay, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', *SERVICES)
    run('docker', 'exec', 'mesher-iot-platform-phase0-nginx-1', 'nginx', '-t')
    run('docker', 'exec', 'mesher-iot-platform-phase0-nginx-1', 'nginx', '-s', 'reload')


def rollback(args, manifest):
    require(args.allow_live_cutover, 'Live cutover requires separate explicit acknowledgement')
    prior_images = running_images()  # NOT required to equal baseline.
    # ops wrapper skips a busy backup with rc=0; require its completion sentinel too.
    output = run('bash', str(ROOT / 'scripts/scanaki-ops-run.sh'), 'backup')
    require(b'Recovery bundle ready: ' in output, 'Backup completion not proved; refusing cutover')
    current_sha(args.expected_current_sha)
    require(running_images() == prior_images, 'Current images changed during backup')
    require(config_hashes() == manifest['config_hashes'] and schema_hash() == manifest['schema_sha256'], 'Compatibility changed')
    attempts = ROOT / 'backups' / 'rollback-attempts'
    attempts.mkdir(parents=True, exist_ok=True, mode=0o700)
    safe_path(attempts, directory=True)
    attempt = Path(tempfile.mkdtemp(prefix='attempt-', dir=attempts))
    journal = {'from': args.expected_current_sha, 'to': SHA, 'previous_images': prior_images, 'state': 'prepared'}
    def record(state):
        journal['state'] = state
        (attempt / 'journal.json').write_text(json.dumps(journal, indent=2) + '\n')
    try:
        source = attempt / 'source'
        source.mkdir()
        extract_source(BASE / 'source.tar', source, manifest['source_aliases'])
        for service, image in manifest['images'].items():
            run('docker', 'image', 'load', '-i', str(BASE / (service + '.tar')))
            require(run('docker', 'image', 'inspect', '--format', '{{.Id}}', image).decode().strip() == image, 'Loaded image mismatch')
        overlay = attempt / 'pins.json'
        overlay.write_text(json.dumps({'services': {k: {'image': v, 'pull_policy': 'never'} for k, v in manifest['images'].items()}}))
        compose_live(overlay, 'config', '--quiet')
        current_sha(args.expected_current_sha)
        require(config_hashes() == manifest['config_hashes'] and schema_hash() == manifest['schema_sha256'], 'Pre-cutover compatibility changed')
        record('replacing-code')
        excludes = rsync_protections()
        run('rsync', '-a', '--delete', *excludes, '--exclude', '/release-commit.txt', str(source) + '/', str(ROOT) + '/')
        marker = ROOT / 'release-commit.txt.rollback-new'
        with marker.open('x') as out:
            out.write(SHA + '\n')
        marker.replace(ROOT / 'release-commit.txt')
        record('replacing-app-services')
        app_replace(overlay)
        require(running_images() == manifest['images'], 'Post-cutover image mismatch')
        healthy = False
        for _ in range(30):
            try:
                run('curl', '--fail', '--silent', '--show-error', '--max-time', '8', 'https://scanaki.uk/api/health')
                healthy = True
                break
            except RuntimeError:
                time.sleep(2)
        require(healthy, 'Rollback public health timeout')
        run('bash', str(ROOT / 'scripts/scanaki-ops-run.sh'), 'health')
        current_sha(SHA)
        require(config_hashes() == manifest['config_hashes'] and schema_hash() == manifest['schema_sha256'], 'Post-cutover compatibility mismatch')
        record('health-passed-transaction-acceptance-pending')
        print('Rollback health passed. Operator must verify transactions before final GO; keep deployments paused.')
    except Exception:
        record('FAILED-operator-recovery-required')
        raise RuntimeError('Rollback stopped; partial cutover possible. Inspect protected rollback journal; escalate to alerts@scanaki.uk') from None


def require_no_declared_volumes(images):
    for image in images.values():
        info = json.loads(run('docker', 'image', 'inspect', image))[0]
        require(info['Id'] == image, 'Preflight image identity mismatch')
        require(not info.get('Config', {}).get('Volumes'), 'Image declares persistent volumes; rehearsal refused before creation')


def cleanup_rehearsal(command, project):
    # Capture resources before Compose removes the container-to-volume association.
    owned = run('docker', 'ps', '-aq', '--no-trunc', '--filter', 'label=scanaki.rollback-rehearsal=' + project).decode().split()
    volumes = set()
    for cid in owned:
        info = json.loads(run('docker', 'inspect', cid))[0]
        require(info['Config']['Labels'].get('scanaki.rollback-rehearsal') == project,
                'Cleanup ownership mismatch; manual intervention required')
        for mount in info['Mounts']:
            if mount['Type'] == 'volume':
                name = mount['Name']
                require(re.fullmatch(r'[0-9a-f]{64}', name), 'Unexpected named volume; refusing automatic removal')
                users = run('docker', 'ps', '-aq', '--no-trunc', '--filter', 'volume=' + name).decode().split()
                require(set(users).issubset(set(owned)), 'Volume has foreign users; refusing removal')
                volumes.add(name)
    run(*command, 'down', '--timeout', '10')
    for name in sorted(volumes):
        require(not run('docker', 'ps', '-aq', '--filter', 'volume=' + name).strip(), 'Volume still attached; refusing removal')
        run('docker', 'volume', 'rm', name)
        require(name not in run('docker', 'volume', 'ls', '-q').decode().split(), 'Anonymous volume remains')
    require(not run('docker', 'ps', '-aq', '--filter', 'label=scanaki.rollback-rehearsal=' + project).strip(), 'Cleanup incomplete')


def rehearse(args, manifest):
    require_no_declared_volumes(manifest['images'])
    project = 'scanaki-rollback-' + uuid.uuid4().hex
    directory = ROOT / 'tmp'
    directory.mkdir(exist_ok=True)
    safe_path(directory, directory=True)
    with tempfile.TemporaryDirectory(prefix='rollback-', dir=directory) as temp:
        compose = Path(temp) / 'isolated.json'
        command = ['docker', 'compose', '-p', project, '-f', str(compose)]
        def definition(candidate):
            return {'services': {service: {
                'image': image, 'pull_policy': 'never', 'network_mode': 'none',
                'read_only': True, 'logging': {'driver': 'none'},
                'labels': {'scanaki.rollback-rehearsal': project, 'scanaki.stage': 'candidate' if candidate else 'baseline'},
                'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'tmpfs': ['/tmp', '/var/cache/nginx', '/var/run'],
                # No upstream resolution, app startup or restored DB duplicated here.
                'entrypoint': ['python', '--version'] if service != 'front' else ['nginx', '-v'],
            } for service, image in manifest['images'].items()}}
        def ids():
            result = {}
            for service, image in manifest['images'].items():
                cid = run(*command, 'ps', '-aq', service).decode().strip()
                require(bool(re.fullmatch(r'[0-9a-f]{12,64}', cid)), 'Missing isolated container')
                info = json.loads(run('docker', 'inspect', cid))[0]
                require(info['Image'] == image, 'Rehearsal pin mismatch')
                require(info['Config']['Labels'].get('scanaki.rollback-rehearsal') == project, 'Rehearsal ownership mismatch')
                require(info['HostConfig']['NetworkMode'] == 'none' and not info['HostConfig']['PortBindings'], 'Isolation mismatch')
                require(info['HostConfig']['LogConfig']['Type'] == 'none', 'Logging mismatch')
                require(not any(m['Type'] in ('bind', 'volume') for m in info['Mounts']), 'Persistent mount refused')
                require(run('docker', 'wait', cid).strip() == b'0', 'Version probe failed')
                result[service] = cid
            return result
        try:
            compose.write_text(json.dumps(definition(True)))
            run(*command, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *SERVICES)
            candidate = ids()
            compose.write_text(json.dumps(definition(False)))
            run(*command, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', *SERVICES)
            replaced = ids()
            require(all(candidate[s] != replaced[s] for s in SERVICES), 'Container replacement not demonstrated')
        finally:
            cleanup_rehearsal(command, project)
    print('Isolated candidate-to-baseline replacement passed. Same-image candidate simulation; not application compatibility proof.')


def self_test():
    from unittest.mock import patch
    calls = []
    with patch(__name__ + '.run', side_effect=lambda *a: calls.append(a) or b''):
        app_replace(Path('/mock/pins.json'))
    up = calls[1]
    require(up[-len(SERVICES):] == SERVICES, 'Unexpected live service set')
    require(all(x in up for x in ('--no-deps', '--no-build', '--pull', 'never')), 'Unsafe live replacement flags')
    require(not any(x in ('db', 'redis', '--remove-orphans', '--build') for c in calls for x in c), 'Unsafe command')
    require(calls[2][-2:] == ('nginx', '-t') and calls[3][-3:] == ('nginx', '-s', 'reload'), 'Edge reload order')
    for name in ('../escape', '/absolute', 'config.env', 'data/a', 'back/uploads/a', 'tmp/a', 'certbot/a', 'a/.env', 'a/key.pem'):
        require(not allowed(name), 'Archive exclusion failed')
    image = 'sha256:' + 'a' * 64
    with patch(__name__ + '.run', return_value=json.dumps([{'Id': image, 'Config': {'Volumes': {'/data': {}}}}]).encode()):
        try:
            require_no_declared_volumes({'back': image})
        except RuntimeError:
            pass
        else:
            raise RuntimeError('Declared VOLUME guard did not fail')
    cid, volume, project = 'b' * 64, 'c' * 64, 'mock-owned'
    def fake(*args):
        if args[:2] == ('docker', 'inspect'):
            return json.dumps([{'Config': {'Labels': {'scanaki.rollback-rehearsal': project}},
                                'Mounts': [{'Type': 'volume', 'Name': volume}]}]).encode()
        if args[:3] == ('docker', 'volume', 'rm'):
            raise RuntimeError('Injected volume removal failure')
        if '--no-trunc' in args:
            return cid.encode()
        return b''
    with patch(__name__ + '.run', side_effect=fake):
        try:
            cleanup_rehearsal(['docker', 'compose', '-p', project], project)
        except RuntimeError as error:
            require(str(error) == 'Injected volume removal failure', 'Unexpected cleanup failure')
        else:
            raise RuntimeError('Volume removal failure was swallowed')
    with patch(__name__ + '.run', side_effect=RuntimeError('Injected cleanup failure')):
        try:
            cleanup_rehearsal(['docker', 'compose'], project)
        except RuntimeError:
            pass
        else:
            raise RuntimeError('Cleanup failure was swallowed')
    print('Mocked command, archive guards, declared-VOLUME rejection and cleanup failure propagation passed.')


def rsync_test():
    # Synthetic files only; run in an existing container with rsync available.
    require(shutil.which('rsync'), 'Existing rsync required; do not install dependencies')
    with tempfile.TemporaryDirectory(prefix='rollback-negative-', dir='/tmp') as temp:
        source, receiver = Path(temp) / 'source', Path(temp) / 'receiver'
        source.mkdir()
        receiver.mkdir()
        paths = {p + '/sentinel' if p in ('data', 'backups', 'tmp', 'certbot', '.git', '.secrets', 'android/scanaki-kitchen/signing', 'back/uploads') else p for p in PROTECTED}
        for prefix in ('', 'nested/', 'nested/deeper/'):
            for name in ('.env', '.env.local', 'back.env', 'private.key', 'cert.pem', 'bundle.p12', 'store.jks', 'store.keystore',
                         '.ENV', '.Env.local', 'BACK.ENV', 'PRIVATE.KEY', 'cert.PEM', 'bundle.P12', 'store.JKS', 'store.KEYSTORE'):
                paths.add(prefix + name)
                paths.add(prefix + name + '.directory/' + name)
            for name in BLOCKED_PARTS:
                paths.add(prefix + name + '/sentinel')
        for name in paths:
            target = receiver / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('synthetic-not-a-credential-' + name)
        before = {name: digest(receiver / name) for name in paths}
        (receiver / 'stale.txt').write_text('obsolete')
        (source / 'current.txt').write_text('replacement')
        run('rsync', '-a', '--delete', *rsync_protections(), str(source) + '/', str(receiver) + '/')
        require(all((receiver / name).is_file() and digest(receiver / name) == value for name, value in before.items()), 'Protected receiver content changed')
        require(not (receiver / 'stale.txt').exists() and (receiver / 'current.txt').read_text() == 'replacement', 'Ordinary code replacement failed')
        print('Rsync receiver test passed: ' + str(len(paths)) + ' protected file hashes unchanged; stale source removed.')
        # Exercise the actual archive writer, not merely the exclusion predicate.
        from unittest.mock import patch
        retained = Path(temp) / 'retained'
        retained.mkdir()
        ordinary = {'release-commit.txt', 'scripts/deploy-scanaki-production.sh', 'back/app/main.py', 'front/package.json', 'agents2/README.md'}
        for required in ordinary:
            target = retained / required
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(SHA if required == 'release-commit.txt' else 'synthetic source')
        (retained / 'agents').symlink_to('agents2', target_is_directory=True)
        for name in paths:
            target = retained / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('synthetic secret sentinel')
        archive_path = Path(temp) / 'source.tar'
        with patch(__name__ + '.RELEASE', retained):
            aliases = archive_source(archive_path)
        with tarfile.open(archive_path, 'r:') as archive:
            names = set(archive.getnames())
        require(not names.intersection(paths), 'Protected sentinel entered source archive')
        require(names == ordinary,
                'Unexpected source archive contents')
        extracted = Path(temp) / 'extracted'
        extracted.mkdir()
        extract_source(archive_path, extracted, aliases)
        require(os.readlink(extracted / 'agents') == 'agents2' and (extracted / 'agents/README.md').read_text() == 'synthetic source', 'Alias extraction semantics lost')
        alias_receiver = Path(temp) / 'alias-receiver'
        alias_receiver.mkdir()
        run('rsync', '-a', '--delete', *rsync_protections(), str(extracted) + '/', str(alias_receiver) + '/')
        require((alias_receiver / 'agents').is_symlink() and os.readlink(alias_receiver / 'agents') == 'agents2', 'Rsync alias semantics lost')
        (retained / 'agents').unlink()
        (retained / 'agents').symlink_to('agents2/', target_is_directory=True)
        with patch(__name__ + '.RELEASE', retained):
            slash_aliases = archive_source(Path(temp) / 'slash.tar')
        slash_stage = Path(temp) / 'slash-stage'
        slash_stage.mkdir()
        extract_source(Path(temp) / 'slash.tar', slash_stage, slash_aliases)
        require(slash_aliases == {'agents': 'agents2/'} and os.readlink(slash_stage / 'agents') == 'agents2/', 'Trailing slash alias not preserved')
        def rejected(fn):
            try:
                fn()
            except RuntimeError:
                return
            raise RuntimeError('Malicious source alias/link was accepted')
        with patch(__name__ + '.RELEASE', retained):
            for bad in ('../agents2', '/agents2', './agents2'):
                (retained / 'agents').unlink()
                (retained / 'agents').symlink_to(bad, target_is_directory=True)
                rejected(lambda: archive_source(Path(temp) / 'rejected.tar'))
            (retained / 'agents').unlink()
            (retained / 'agents').symlink_to('agents2', target_is_directory=True)
            (retained / 'other-link').symlink_to('agents2', target_is_directory=True)
            rejected(lambda: archive_source(Path(temp) / 'rejected.tar'))
        malicious = Path(temp) / 'malicious.tar'
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            with tarfile.open(malicious, 'w') as archive:
                entry = tarfile.TarInfo('agents')
                entry.type = kind
                entry.linkname = 'agents2'
                archive.addfile(entry)
            rejected(lambda: extract_source(malicious, Path(temp) / 'unused', aliases))
        print('Source archive/extraction/rsync alias tests passed; escaping/nonexact aliases, other links and tar links rejected.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', nargs='?', choices=['check', 'capture', 'rehearse', 'rollback', 'self-test', 'rsync-test'], default='check')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--expected-current-sha')
    parser.add_argument('--baseline-sha256')
    parser.add_argument('--deployments-paused', action='store_true')
    parser.add_argument('--allow-live-cutover', action='store_true')
    args = parser.parse_args()
    if args.action == 'self-test':
        self_test()
        return
    if args.action == 'rsync-test':
        rsync_test()
        return
    if not args.execute:
        print('NOOP: explicit --execute and review acknowledgements required. See --help.')
        return
    require(args.deployments_paused, 'Pause all deployment writers, including pre-lock CI rsync, before execution')
    require(os.geteuid() == 0, 'Root required for deployment lock')
    os.umask(0o077)
    safe_path(ROOT, directory=True)
    with open('/run/lock/scanaki-production-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current_sha(args.expected_current_sha)
        if args.action == 'capture':
            capture(args)
        elif args.action in ('rollback', 'rehearse'):
            manifest = baseline(args)
            if args.action == 'rollback':
                rollback(args, manifest)
            else:
                rehearse(args, manifest)
        else:
            print('Current marker matches; no changes made.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAILED: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
        raise SystemExit(1)
