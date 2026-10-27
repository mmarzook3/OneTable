"""Offline contract tests. No Docker, SSH, systemd, network or production data."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import subprocess
import sys
import re
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import executor
import receiver
import runtime_assets

SHA = 'a' * 40


class HomeDeployTests(unittest.TestCase):
    def test_superseded_queued_upload_removes_only_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release = root / SHA
            release.mkdir()
            for name in ('images.tar', 'digest', 'compose.before.json'):
                (release / name).write_text('fixture')
            (release / 'status').write_text('queued\n')
            (root / 'latest').write_text('b' * 40)
            fake_fcntl = SimpleNamespace(flock=lambda *args: None, LOCK_EX=1)
            with patch.object(executor, 'STATE', root), \
                 patch.object(sys, 'argv', ['executor.py', SHA]), \
                 patch.dict(sys.modules, {'fcntl': fake_fcntl}), \
                 patch.object(executor.os, 'umask'), patch.object(executor, 'deploy') as deploy:
                executor.main()
                deploy.assert_not_called()
            self.assertFalse((release / 'images.tar').exists())
            self.assertEqual((release / 'status').read_text().strip(), 'superseded')
            self.assertEqual((release / 'digest').read_text(), 'fixture')
            self.assertEqual((release / 'compose.before.json').read_text(), 'fixture')
            # A newer submission must not discard an older FAILED archive.
            (release / 'images.tar').write_text('failed archive')
            (release / 'status').write_text('failed\n')
            with patch.object(executor, 'STATE', root), \
                 patch.object(sys, 'argv', ['executor.py', SHA]), \
                 patch.dict(sys.modules, {'fcntl': fake_fcntl}), \
                 patch.object(executor.os, 'umask'):
                executor.main()
            self.assertEqual((release / 'images.tar').read_text(), 'failed archive')
            self.assertEqual((release / 'status').read_text().strip(), 'failed')

    def test_runtime_user_preserves_explicit_and_inherited_identity(self):
        config = {'services': {s: {'image': 'restored'} for s in executor.SERVICES}}
        config['services']['front']['user'] = 'nginx:nginx'
        users = {'back': '1000:1000', 'front': '101:101', 'ws-bridge': '1000'}
        candidate = executor.next_config(config, SHA, users)
        self.assertEqual(candidate['services']['back']['user'], '1000:1000')
        self.assertEqual(candidate['services']['ws-bridge']['user'], '1000')
        self.assertEqual(candidate['services']['front']['user'], 'nginx:nginx')
        self.assertNotIn('user', config['services']['back'])
        empty = executor.next_config(config, SHA, {s: '' for s in executor.APPS})
        self.assertNotIn('user', empty['services']['back'])
        config['services']['back']['user'] = '0:0'
        self.assertEqual(executor.next_config(config, SHA, users)['services']['back']['user'], '0:0')

    def test_runtime_identity_resolution_and_image_compatibility_fail_closed(self):
        settings = {'image': executor.image_name('back', SHA), 'user': '1000:1000'}
        with patch.object(executor, 'run', side_effect=['1000\n1000\n', '1000\n1000\n']) as run:
            executor.validate_runtime_user('back', settings, 'current-back')
            args = run.call_args.args
            self.assertIn('--read-only', args)
            self.assertIn('--network', args)
            self.assertEqual(args[args.index('--user') + 1], '1000:1000')
        for actual in ('0\n0\n', '1000\n0\n'):
            with patch.object(executor, 'run', side_effect=['1000\n1000\n', actual]):
                with self.assertRaisesRegex(ValueError, 'UID/GID'):
                    executor.validate_runtime_user('back', settings, 'current-back')
        with patch.object(executor, 'run', side_effect=['1000\n1000\n', RuntimeError('unreadable image')]):
            with self.assertRaisesRegex(RuntimeError, 'unreadable'):
                executor.validate_runtime_user('back', settings, 'current-back')

    def test_receiver_records_failed_systemd_submission(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = b'archive fixture'
            digest = hashlib.sha256(data).hexdigest()
            fake_fcntl = SimpleNamespace(flock=lambda *args: None, LOCK_EX=1)
            with patch.object(receiver, 'ROOT', root), \
                 patch.object(sys, 'argv', ['receiver.py', f'submit {SHA} {digest}']), \
                 patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(data))), \
                 patch.dict(sys.modules, {'fcntl': fake_fcntl}), \
                 patch.object(receiver.os, 'umask'), \
                 patch.object(receiver.shutil, 'disk_usage', return_value=SimpleNamespace(free=16 * 1024**3)), \
                 patch.object(receiver.subprocess, 'run', side_effect=RuntimeError('systemd unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'systemd unavailable'):
                    receiver.main()
            self.assertEqual((root / SHA / 'status').read_text().strip(), 'failed')

    def test_pinned_runtime_assets_and_unsafe_archives(self):
        manifest = {'sites': [{'slug': 'venue', 'deploySubpath': 'es'}]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def make(extra=None, placeholder=False):
                archive = root / 'assets.tar.gz'
                with tarfile.open(archive, 'w:gz') as tar:
                    for name, data in [('sites/venue/es/index.html', b'bundle not loaded' if placeholder else b'<html>venue</html>'),
                                       ('downloads/app.apk', b'apk-fixture')]:
                        entry = tarfile.TarInfo(name)
                        entry.size = len(data)
                        tar.addfile(entry, io.BytesIO(data))
                    if extra:
                        tar.addfile(extra)
                return archive, hashlib.sha256(archive.read_bytes()).hexdigest()
            archive, digest = make()
            output = root / 'valid'
            output.mkdir()
            runtime_assets.unpack(archive, output, digest, manifest)
            self.assertEqual((output / 'downloads/app.apk').read_bytes(), b'apk-fixture')
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                runtime_assets.unpack(archive, root / 'bad-hash', '0' * 64, manifest)
            bad_names = ['../outside', '/absolute', 'other/file', 'sites/../../outside', 'sites\\escape']
            members = [tarfile.TarInfo(name) for name in bad_names]
            link = tarfile.TarInfo('sites/link')
            link.type = tarfile.SYMTYPE
            link.linkname = '/etc/passwd'
            members.append(link)
            for number, member in enumerate(members):
                archive, digest = make(member)
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    runtime_assets.unpack(archive, root / f'bad-{number}', digest, manifest)
            archive, digest = make(placeholder=True)
            with self.assertRaisesRegex(ValueError, 'placeholder'):
                runtime_assets.unpack(archive, root / 'placeholder', digest, manifest)

    def test_receiver_accepts_only_exact_protocol(self):
        self.assertEqual(receiver.parse(f'status {SHA}'), ('status', SHA, None))
        self.assertEqual(receiver.parse(f'submit {SHA} ' + 'b' * 64)[0], 'submit')
        for command in (f'submit {SHA}', f'status {SHA} ' + 'b' * 64,
                        'status master', f'status {SHA};id', f'status {SHA}\n', 'sh'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                receiver.parse(command)

    def test_compose_preserves_smtp_secrets_networks_volumes_and_safe_start(self):
        config = {'services': {s: {'image': 'restored:' + s} for s in executor.SERVICES},
                  'networks': {'data': {'internal': True}},
                  'volumes': {'db': {'external': True}}}
        config['services']['back'].update({
            'extra_hosts': {'smtp-relay.gmail.com': '10.77.0.1'},
            'command': ['python', '/private/safe_start.py'],
            'environment': {'PRIVATE_SETTING': 'fixture'},
            'volumes': ['/private/safe_start.py:/private/safe_start.py:ro']})
        original = copy.deepcopy(config)
        result = executor.next_config(config, SHA, {s: '' for s in executor.APPS})
        self.assertEqual(config, original)
        for service in executor.APPS:
            self.assertEqual(result['services'][service]['image'], executor.image_name(service, SHA))
            result['services'][service]['image'] = config['services'][service]['image']
        self.assertEqual(result, original)

    def test_unexpected_services_and_builds_fail_closed(self):
        config = {'services': {s: {'image': s} for s in executor.SERVICES}}
        config['services']['unrelated'] = {}
        with self.assertRaises(ValueError):
            executor.next_config(config, SHA, {s: '' for s in executor.APPS})
        del config['services']['unrelated']
        config['services']['front']['build'] = '.'
        with self.assertRaises(ValueError):
            executor.next_config(config, SHA, {s: '' for s in executor.APPS})

    def archive(self, path, tags, extra=None):
        data = json.dumps([{'RepoTags': [tag]} for tag in tags]).encode()
        with tarfile.open(path, 'w') as archive:
            entry = tarfile.TarInfo('manifest.json')
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
            if extra:
                archive.addfile(tarfile.TarInfo(extra))

    def test_image_archive_only_accepts_own_three_revision_tags(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'images.tar'
            tags = [executor.image_name(s, SHA) for s in executor.APPS]
            self.archive(path, tags)
            executor.validate_archive(path, SHA)
            for invalid in (tags + ['other-project:latest'], tags[:-1],
                            [tag.replace(SHA, 'master') for tag in tags]):
                self.archive(path, invalid)
                with self.assertRaises(ValueError):
                    executor.validate_archive(path, SHA)
            for extra in ('../escape', '/absolute'):
                self.archive(path, tags, extra)
                with self.assertRaises(ValueError):
                    executor.validate_archive(path, SHA)

    def test_preflight_failure_never_reaches_docker_load_or_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = {'services': {s: {'image': s} for s in executor.SERVICES}}
            (root / 'compose.json').write_text(json.dumps(config))
            with patch.object(executor, 'ROOT', root), patch.object(executor, 'run', return_value='') as run:
                with self.assertRaisesRegex(ValueError, 'Missing HOME service'):
                    executor.deploy(SHA, root)
                self.assertEqual(run.call_count, 1)
                self.assertNotIn('stop', run.call_args.args)

    def deployment_fixture(self, temporary, backup_ok=True, migration_ok=True):
        root = Path(temporary)
        release = root / SHA
        release.mkdir()
        config = {'services': {s: {'image': 'old-' + s} for s in executor.SERVICES}}
        config['services']['back']['extra_hosts'] = {'smtp-relay.gmail.com': '10.77.0.1'}
        (root / 'compose.json').write_text(json.dumps(config))
        (release / 'status').write_text('preparing\n')
        self.archive(release / 'images.tar', [executor.image_name(s, SHA) for s in executor.APPS])
        (release / 'digest').write_text(hashlib.sha256((release / 'images.tar').read_bytes()).hexdigest())
        calls = []
        timestamps = iter(('100', '200'))

        def run(*args, capture=False):
            calls.append(args)
            if args[:2] == ('systemctl', 'show'):
                if 'ActiveState' in args:
                    return 'inactive\n'
                if 'ExecMainStartTimestampMonotonic' in args:
                    return next(timestamps)
                if 'Result' in args:
                    return 'success' if backup_ok else 'failed'
            if args[:3] == ('docker', 'image', 'inspect'):
                return json.dumps([{'Id': 'sha256:fixture', 'Os': 'linux', 'Architecture': 'amd64',
                    'Config': {'Labels': {'org.opencontainers.image.revision': SHA,
                    'org.opencontainers.image.source': 'https://github.com/mmarzook3/OneTable'}}}])
            if args[:2] == ('docker', 'inspect'):
                return json.dumps([{'Image': 'sha256:fixture', 'Config': {'User': '1000:1000'}, 'State': {'Health': {'Status': 'healthy'}}}])
            if args[:2] in (('docker', 'exec'), ('docker', 'run')):
                return '1000\n1000\n'
            if 'ps' in args:
                return 'fixture-container'
            if 'app.migrate' in args and not migration_ok:
                raise RuntimeError('migration failed')
            return ''
        return root, release, config, calls, run

    def test_fresh_backup_failure_prevents_stopping_writers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, release, original, calls, run = self.deployment_fixture(temporary, backup_ok=False)
            with patch.object(executor, 'ROOT', root), patch.object(executor, 'STATE', root), \
                 patch.object(executor, 'run', side_effect=run), patch.object(executor, 'probe'), \
                 patch.object(executor.shutil, 'disk_usage', return_value=SimpleNamespace(free=16 * 1024**3)):
                with self.assertRaisesRegex(ValueError, 'Fresh native backup'):
                    executor.deploy(SHA, release)
            self.assertFalse(any('stop' in c or 'app.migrate' in c for c in calls))
            self.assertEqual(json.loads((root / 'compose.json').read_text()), original)
            self.assertTrue((release / 'images.tar').exists())

    def test_successful_sequence_preserves_private_config_and_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, release, original, calls, run = self.deployment_fixture(temporary)
            with patch.object(executor, 'ROOT', root), patch.object(executor, 'STATE', root), \
                 patch.object(executor, 'run', side_effect=run), patch.object(executor, 'probe'), \
                 patch.object(executor.shutil, 'disk_usage', return_value=SimpleNamespace(free=16 * 1024**3)):
                executor.deploy(SHA, release)
            self.assertEqual((release / 'status').read_text().strip(), 'succeeded')
            self.assertFalse((release / 'images.tar').exists())
            self.assertTrue((release / 'digest').exists())
            self.assertFalse((root / 'recovery-required').exists())
            self.assertEqual(json.loads((release / 'compose.before.json').read_text()), original)
            self.assertEqual(json.loads((root / 'compose.json').read_text()), executor.next_config(original, SHA, {s: '1000:1000' for s in executor.APPS}))
            stop = next(i for i, c in enumerate(calls) if 'stop' in c)
            migrate = [i for i, c in enumerate(calls) if 'app.migrate' in c]
            start = next(i for i, c in enumerate(calls) if 'up' in c)
            self.assertTrue(stop < migrate[0] < migrate[1] < start)
            self.assertEqual(calls[stop][-3:], executor.APPS)
            self.assertEqual(calls[start][-3:], executor.APPS)
            self.assertIn('--no-deps', calls[start])
            self.assertFalse(any('seed' in ' '.join(c) for c in calls))

    def test_failed_migration_leaves_durable_recovery_marker_and_no_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, release, original, calls, run = self.deployment_fixture(temporary, migration_ok=False)
            with patch.object(executor, 'ROOT', root), patch.object(executor, 'STATE', root), \
                 patch.object(executor, 'run', side_effect=run), patch.object(executor, 'probe'), \
                 patch.object(executor.shutil, 'disk_usage', return_value=SimpleNamespace(free=16 * 1024**3)):
                with self.assertRaisesRegex(RuntimeError, 'migration failed'):
                    executor.deploy(SHA, release)
            self.assertEqual((root / 'recovery-required').read_text().strip(), SHA)
            self.assertTrue((release / 'images.tar').exists())
            self.assertFalse(any('up' in c for c in calls))

    def test_workflow_paths_and_policy(self):
        # PyYAML is optional locally; CI also checks the behavioral contracts above.
        try:
            import yaml
        except ImportError:
            self.skipTest('PyYAML unavailable; YAML validation remains external')
        import fnmatch
        root = Path(__file__).resolve().parents[2]
        for filename in ('release-checks.yml', 'deploy-scanaki-production.yml'):
            workflow = yaml.safe_load((root / '.github/workflows' / filename).read_text())
            events = workflow.get('on', workflow.get(True))
            self.assertTrue(workflow['concurrency']['cancel-in-progress'])
            self.assertIn('github.repository', workflow['concurrency']['group'])
            for event in ('push', 'pull_request'):
                if event not in events:
                    continue
                if event == 'pull_request' and filename == 'release-checks.yml':
                    self.assertIn('paths', events[event])
                    steps = workflow['jobs']['release-checks']['steps']
                    script = steps[0]['with']['script']
                    paths = json.loads(re.search(r'const patterns = (\[.*?\]);', script)[1])
                    paths.append('.github/workflows/release-checks-docs.yml')
                    self.assertEqual(paths, events[event]['paths'])
                    for step in steps[1:]:
                        self.assertEqual(step['if'], "steps.changes.outputs.eligible == 'true'")
                else:
                    paths = events[event]['paths']
                for changed in ('back/app/main.py', 'back/migrations/123.sql',
                                'front/package-lock.json', 'ws-bridge/main.py',
                                '.github/workflows/' + filename):
                    self.assertTrue(any(fnmatch.fnmatchcase(changed, p) for p in paths), changed)
                for changed in ('README.md', 'docs/scanaki-home-migration-20261027.md',
                                'scripts/home-deploy/README.md', 'agents2/tasks/task.md'):
                    self.assertFalse(any(fnmatch.fnmatchcase(changed, p) for p in paths), changed)

    def test_actual_required_check_gate_for_docs_code_renames_and_api_failure(self):
        try:
            import yaml
        except ImportError:
            self.skipTest('PyYAML unavailable')
        root = Path(__file__).resolve().parents[2]
        workflow = yaml.safe_load((root / '.github/workflows/release-checks.yml').read_text())
        script = workflow['jobs']['release-checks']['steps'][0]['with']['script']
        harness = '''
const gate = new (Object.getPrototypeOf(async function(){}).constructor)('context', 'github', 'core', SCRIPT);
async function check(files, expected, fail=false) {
  let output;
  const github = {rest:{pulls:{listFiles(){}}}, paginate: async()=> {if(fail)throw Error('denied'); return files;}};
  const core = {setOutput:(key,value)=>{output=value;}, notice:()=>{}};
  try { await gate({eventName:'pull_request',repo:{},issue:{number:1}},github,core); }
  catch(error) {if(fail && output===undefined)return; throw error;}
  if(fail || output!==expected)throw Error('wrong eligibility: '+output);
}
(async()=>{
 await check([{filename:'docs/notes.md'}], 'false');
 await check([{filename:'back/app/main.py'}], 'true');
 await check([{filename:'config/scanaki-runtime-assets.json'}], 'true');
 await check([{filename:'docs/old.md',previous_filename:'front/src/old.ts'}], 'true');
 await check(Array(3000).fill({filename:'docs/notes.md'}), 'true');
 await check([], undefined, true);
})().catch(e=>{console.error(e);process.exit(1);});
'''.replace('SCRIPT', json.dumps(script))
        subprocess.run(['node', '-'], input=harness, text=True, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
