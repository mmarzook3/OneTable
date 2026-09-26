"""Isolated recovery coordinator and in-container probe. No live cutover.

Config integrity is checked, but recovered credentials are never activated.
The previous frontend is served alongside the current restored API. Browser
coverage is login rendering and authenticated GETs, not settlement or backend rollback.
Checksums detect corruption, not malicious replacement: no HMAC is claimed.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import time
import urllib.request

CONFIG = {'config.env', 'deployment-secrets.env', 'docker-compose.scanaki.yml',
          'nginx.scanaki.conf', 'release-commit.txt'}
SQL = re.compile(r'database/scanaki_[0-9]{8}_[0-9]{6}\.sql\.gz\.enc')
OLD_HASH = '4c11c7b2d50431178f105ae58d7590b23b28bacaabe809e686c9dba6356fb8c5'
STAGE = 'arguments'
BROWSER_IMAGE = 'sha256:87099d8a52e3c61383fca07257d0b0a51784b8d3a3e41a482c2af514e6e155cb'
BROWSER_JS = r'''
const puppeteer = require('puppeteer-core');
let stage='launch';
(async () => {
 let raw=''; for await (const chunk of process.stdin) raw+=chunk;
 const session=JSON.parse(raw); raw='';
 const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,
   userDataDir:'/tmp/recovery-browser',args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
 try {
  for(const port of [8080,8081]) {
   stage=port===8080?'current-render':'preserved-render';
   const origin=`http://127.0.0.1:${port}`;
   const context=await browser.createBrowserContext();
   await context.setCookie({name:'access_token',value:session.token,url:origin,httpOnly:true,sameSite:'Lax'});
   const page=await context.newPage(); let errors=0,writes=0,blocked=0;
   page.on('pageerror',()=>errors++);
   await page.setRequestInterception(true);
   page.on('request',req=>{
    const url=new URL(req.url());
    if(req.method()!=='GET' && req.method()!=='HEAD'){writes++;return req.abort();}
    if(url.origin!==origin && !['data:','blob:'].includes(url.protocol)){blocked++;return req.abort();}
    return req.continue();
   });
   await page.goto(origin+'/customer/login',{waitUntil:'domcontentloaded',timeout:30000});
   await page.waitForSelector('input[type="password"]',{visible:true,timeout:30000});
   stage=port===8080?'current-api':'preserved-api';
   const ok=await page.evaluate(async()=>{
    for(const path of ['/api/users/me','/api/orders','/api/products']){
     const r=await fetch(path,{credentials:'same-origin'}); if(r.status!==200)return false;
     const data=await r.json();if(!data||typeof data!=='object')return false;
    }return true;
   });
   if(!ok||errors||writes)throw new Error('browser acceptance');
   console.log(JSON.stringify({frontend:port===8080?'current':'preserved',login_render:'PASS',
    authenticated_api_reads:3,browser_exceptions:errors,write_attempts:writes,external_requests_blocked:blocked}));
   await context.close();
  }
 } finally {await browser.close();}
})().catch(()=>{console.error('FAIL isolated application rehearsal stage=browser-'+stage+';');process.exitCode=1;});
'''


def stage(value):
    global STAGE
    STAGE = value


def require(value):
    if not value:
        raise ValueError('rehearsal guard')


def call(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        for kind in (b'SyntaxError', b'PermissionError', b'ModuleNotFoundError', b'No such file', b'not running'):
            if kind in result.stderr:
                print('FAIL subprocess category=' + kind.decode(), file=sys.stderr)
        for value in re.findall(rb'FAIL isolated application rehearsal stage=([a-z-]+);', result.stderr):
            print('FAIL child stage=' + value.decode(), file=sys.stderr)
        raise ValueError('subprocess failed')
    return result.stdout


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def allowed(name):
    return (all(p not in ('', '.', '..') for p in name.split('/'))
            and not name.startswith('/') and '\\' not in name
            and (name in CONFIG or name == 'manifest.json'
                 or name == 'data/uploads' or name.startswith('data/uploads/')
                 or SQL.fullmatch(name.removesuffix('.sha256')) is not None))


def unpack(stream, destination, bundle):
    seen = set()
    total = 0
    with tarfile.open(fileobj=stream, mode='r|*') as archive:
        for item in archive:
            name = item.name.removeprefix('./') if not bundle else item.name
            if not bundle and name in ('', '.') and item.isdir():
                continue
            require(name not in seen and (item.isfile() or item.isdir()))
            require(allowed(name) if bundle else
                    (not name.startswith('/') and '\\' not in name
                     and all(p not in ('', '.', '..') for p in name.split('/'))))
            require(len(seen) < 20000 and 0 <= item.size <= 256 * 1024 * 1024)
            total += item.size
            require(total <= 1024 * 1024 * 1024)
            seen.add(name)
            target = destination / name
            if item.isdir():
                require(not bundle or name == 'data/uploads' or name.startswith('data/uploads/'))
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(item) as source, target.open('xb') as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                target.chmod(0o600)
    return seen


def prepare():
    stage('archive-extract')
    root = Path('/recovery/bundle')
    root.mkdir(mode=0o700)
    seen = unpack(sys.stdin.buffer, root, True)
    stage('manifest-shape')
    manifest = json.loads((root / 'manifest.json').read_text())
    files, directories = manifest['files'], manifest['directories']
    require(manifest['version'] == 1 and isinstance(files, dict) and isinstance(directories, list))
    require(len(directories) == len(set(directories)) and set(files).isdisjoint(directories))
    require(seen == set(files) | set(directories) | {'manifest.json'})
    require(CONFIG <= set(files) and 'data/uploads' in directories)
    database = manifest['database']
    require(SQL.fullmatch(database) and database in files and database + '.sha256' in files)
    stage('manifest-file-hashes')
    for name, expected in files.items():
        require(allowed(name) and re.fullmatch('[a-f0-9]{64}', expected))
        require(digest(root / name) == expected)
    for name in directories:
        require((root / name).is_dir())
    stage('embedded-sql-checksum')
    side = (root / (database + '.sha256')).read_text().strip()
    require(re.fullmatch(re.escape(files[database]) + r' [ *]' + re.escape(Path(database).name), side))
    stage('recovered-release-marker')
    require(re.fullmatch('[a-f0-9]{40}', (root / 'release-commit.txt').read_text().strip()))
    # Never source recovered env files. Move only verified uploads into runtime.
    stage('uploads-restore')
    import shutil
    shutil.copytree(root / 'data/uploads', '/app/uploads', dirs_exist_ok=True)
    Path('/recovery/database-path').write_text(str(root / database))


def api_probe():
    for _ in range(120):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8020/health', timeout=2) as response:
                require(response.status == 200)
            break
        except Exception:
            time.sleep(0.5)
    else:
        raise ValueError('startup')
    for path in ('/openapi.json', '/docs'):
        with urllib.request.urlopen('http://127.0.0.1:8020' + path, timeout=5) as response:
            require(response.status == 200 and len(response.read()) > 20)
    manifest = json.loads(Path('/recovery/bundle/manifest.json').read_text())
    uploads = 0
    for name, expected in manifest['files'].items():
        if name.startswith('data/uploads/'):
            require(digest(Path('/app/uploads') / name.removeprefix('data/uploads/')) == expected)
            uploads += 1
    require(uploads > 0)
    print(json.dumps({'startup_api': 'PASS', 'restored_upload_hashes': uploads,
                      'configuration_integrity': 'PASS', 'production_credentials_activated': False}))


def private_probe():
    stage('crypto-key-recovery')
    import contextlib
    import logging
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from dotenv import dotenv_values
        keys = {dotenv_values(Path('/recovery/bundle') / name, interpolate=False).get('SECRET_KEY')
                for name in ('config.env', 'deployment-secrets.env')}
        keys.discard(None)
        keys.discard('')
        require(len(keys) == 1)
        key = keys.pop()
        require(len(key) >= 20 and '${' not in key)
        from app import main, models, security
        from app.db import engine
        from sqlalchemy import text
        from cryptography.fernet import Fernet
        import base64
        checked = 0
        # Direct cryptographic verification only: never hand decrypted credentials
        # to an SDK, SMTP client or running application settings.
        specs = [
            ('tenant', 'stripe_secret_key_encrypted', ':one-table:tenant-payments:v1', 'enc:v1:'),
            ('tenant', 'stripe_webhook_secret_encrypted', ':one-table:tenant-payments:v1', 'enc:v1:'),
            ('platform_settings', 'smtp_password_encrypted', ':scanaki:platform-smtp:v1', 'platform-smtp:v1:'),
            ('tenant', 'clock_qr_token_encrypted', ':clock_qr_fernet_v1', ''),
            ('delivery_marketplace_integration', 'credentials_encrypted', ':delivery_integration_fernet_v1', ''),
            ('social_connection', 'oauth_payload_encrypted', ':social_oauth_fernet_v1', ''),
        ]
        with engine.connect() as connection:
            for table, column, salt, prefix in specs:
                exists = connection.execute(text('SELECT 1 FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=:t AND column_name=:c'), {'t': table, 'c': column}).first()
                if not exists:
                    continue
                fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256((key + salt).encode()).digest()))
                for value in connection.execute(text(f'SELECT "{column}" FROM "{table}" WHERE "{column}" IS NOT NULL')):
                    if not value[0]:
                        continue
                    require(value[0].startswith(prefix))
                    plain = fernet.decrypt(value[0][len(prefix):].encode())
                    require(bool(plain))
                    del plain
                    checked += 1
            require(checked > 0)
            owner = connection.execute(text('SELECT email, tenant_id, token_version FROM "user" WHERE role=\'owner\' AND tenant_id IS NOT NULL ORDER BY id LIMIT 1')).first()
            require(owner is not None)
            from datetime import timedelta
            token = security.create_access_token({'sub': owner.email, 'tenant_id': owner.tenant_id,
                    'provider_id': None, 'token_version': owner.token_version}, expires_delta=timedelta(minutes=10))
        stage('authenticated-restored-api')
        for endpoint in ('/users/me', '/orders', '/products'):
            request = urllib.request.Request('http://127.0.0.1:8020' + endpoint,
                      headers={'Cookie': 'access_token=' + token})
            with urllib.request.urlopen(request, timeout=10) as response:
                require(response.status == 200)
                payload = json.loads(response.read())
                require(isinstance(payload, (dict, list)))
        Path('/recovery/browser-session.json').write_text(json.dumps({'token': token}))
        Path('/recovery/browser-session.json').chmod(0o600)
    print(json.dumps({'crypto_ciphertexts_verified': checked, 'authenticated_read_endpoints': 3,
                      'provider_mail_credentials_activated': False}))


def serve_old():
    from http.server import SimpleHTTPRequestHandler, HTTPServer
    root = Path('/recovery/old')
    indices = list(root.rglob('index.html'))
    require(len(indices) == 1)
    directory = indices[0].parent
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)
        def log_message(self, *args):
            pass
        def do_GET(self):
            if self.path.startswith('/api/'):
                try:
                    request = urllib.request.Request('http://127.0.0.1:8020/' + self.path[5:],
                              headers={'Cookie': self.headers.get('Cookie', '')})
                    with urllib.request.urlopen(request, timeout=10) as response:
                        body = response.read()
                        self.send_response(response.status)
                        self.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
                        self.end_headers()
                        self.wfile.write(body)
                except Exception:
                    self.send_error(502)
                return
            path = self.path.split('?', 1)[0]
            if not Path(self.translate_path(path)).is_file():
                self.path = '/index.html'
            super().do_GET()
    HTTPServer(('127.0.0.1', 8081), Handler).serve_forever()


def coordinator(args):
    require(len(args) == 6 and args[0] == '--execute')
    _, source, sha, back, front, pg = args
    require(re.fullmatch('[a-f0-9]{40}', sha))
    require(all(re.fullmatch('sha256:[a-f0-9]{64}', x) for x in (back, front, pg)))
    stage('passphrase')
    require(len(os.environ.get('SCANAKI_BACKUP_PASSPHRASE', '')) >= 20)
    stage('offsite-path-checksum')
    root = Path('/opt/scanaki/app')
    source = Path(source)
    require(source.is_absolute() and source.name == 'bundle.tar.enc')
    require(source.resolve().is_relative_to(root / 'tmp/phase4-offsite'))
    for path in (source, Path(str(source) + '.sha256')):
        require(path.is_file() and all(not p.is_symlink() for p in (path, *path.parents)))
    checksum = Path(str(source) + '.sha256').read_text().strip()
    require(re.fullmatch(re.escape(digest(source)) + r' [ *]bundle\.tar\.enc', checksum))
    stage('rollback-archive-checksum')
    old = root / 'backups/recovery/scanaki_frontend_7a3e0cbd_20260908.tar.gz'
    require(old.is_file() and all(not p.is_symlink() for p in (old, *old.parents)))
    require(digest(old) == OLD_HASH)
    stage('deployment-identity')
    import fcntl
    lock = Path('/run/lock/scanaki-production-deploy.lock')
    require(lock.is_file() and not lock.is_symlink())
    with lock.open('rb') as handle:
        fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        require((root / 'release-commit.txt').read_text().strip() == sha)
        for container, expected in [('scanaki-back', back), ('scanaki-front', front), ('scanaki-db', pg)]:
            require(call(['docker', 'inspect', container, '--format', '{{.Image}}']).decode().strip() == expected)
    import uuid
    nonce = uuid.uuid4().hex
    db, app, web = [f'scanaki-p4-{kind}-{nonce}' for kind in ('db', 'app', 'web')]
    browser = f'scanaki-p4-browser-{nonce}'
    names = [browser, web, app, db]
    passed = False
    cleanup_ok = True
    try:
        stage('isolated-db-create')
        common = ['--log-driver', 'none', '--label', f'scanaki.rehearsal={nonce}']
        call(['docker', 'run', '-d', '--name', db, *common, '--network', 'none',
              '--tmpfs', '/tmp:rw,size=768m', '-e', 'PGDATA=/tmp/pgdata',
              '-e', 'POSTGRES_USER=pos', '-e', 'POSTGRES_PASSWORD=synthetic-recovery',
              '-e', 'POSTGRES_DB=scanaki_phase4_restore', pg])
        env = {'DB_HOST': '127.0.0.1', 'DB_PORT': '5432', 'DB_USER': 'pos',
               'DB_PASSWORD': 'synthetic-recovery', 'DB_NAME': 'scanaki_phase4_restore',
               'SECRET_KEY': 'synthetic-recovery-signing-key-not-production',
               'REFRESH_SECRET_KEY': 'synthetic-recovery-refresh-key-not-production',
               'STRIPE_SECRET_KEY': '', 'SMTP_HOST': '', 'REDIS_URL': '', 'PYTHONPATH': '/app'}
        options = [value for pair in env.items() for value in ('-e', '='.join(pair))]
        stage('isolated-app-create')
        call(['docker', 'run', '-d', '--name', app, *common, '--network', f'container:{db}',
              '--tmpfs', '/recovery:rw,size=1536m', '--tmpfs', '/app/uploads:rw,size=512m',
              *options, '--entrypoint', 'sleep', back, '900'])
        call(['docker', 'exec', '-i', app, 'sh', '-c', 'cat > /recovery/probe.py'],
             input=Path(__file__).read_bytes())
        # Plaintext only traverses anonymous pipes into the isolated container tmpfs.
        stage('bundle-decrypt-validate')
        decrypt = subprocess.Popen(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2',
                    '-iter', '200000', '-pass', 'env:SCANAKI_BACKUP_PASSPHRASE', '-in', str(source)],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            call(['docker', 'exec', '-i', app, 'python', '/recovery/probe.py', '--prepare'], stdin=decrypt.stdout)
        finally:
            decrypt.stdout.close()
            require(decrypt.wait(timeout=30) == 0)
        stage('isolated-db-readiness')
        for _ in range(80):
            if subprocess.run(['docker', 'exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'pos'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.25)
        else:
            raise ValueError('database readiness')
        # A host pipeline decrypts the embedded encrypted SQL, never a plaintext file.
        stage('isolated-sql-restore')
        pipeline = ('set -euo pipefail; docker exec "$1" sh -c \'cat "$(cat /recovery/database-path)"\' '
                    '| openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:SCANAKI_BACKUP_PASSPHRASE '
                    '| gzip -dc | docker exec -i "$2" psql -X -U pos -d scanaki_phase4_restore -v ON_ERROR_STOP=1')
        call(['bash', '-c', pipeline, 'restore', app, db])
        stage('application-startup-api')
        call(['docker', 'exec', '-d', app, 'sh', '-c',
              'cd /app && exec uvicorn app.main:app --host 127.0.0.1 --port 8020 >/dev/null 2>&1'])
        print(call(['docker', 'exec', app, 'python', '/recovery/probe.py', '--api']).decode().strip())
        stage('crypto-authenticated-api')
        print(call(['docker', 'exec', app, 'python', '/recovery/probe.py', '--private']).decode().strip())
        # nginx uses image assets, without live upstream configuration or published ports.
        stage('frontend-http-compatibility')
        call(['docker', 'run', '-d', '--name', web, *common, '--network', f'container:{db}',
              '--read-only', '--tmpfs', '/tmp:rw,size=64m',
              '--tmpfs', '/var/cache/nginx:rw,size=64m', '--tmpfs', '/var/run:rw,size=8m',
              '--entrypoint', 'sleep', front, '900'])
        config = b'pid /var/run/nginx.pid; error_log /dev/null; events {} http { access_log off; include /etc/nginx/mime.types; client_body_temp_path /var/cache/nginx/client; proxy_temp_path /var/cache/nginx/proxy; proxy_buffering off; proxy_request_buffering off; proxy_max_temp_file_size 0; server { listen 8080; root /usr/share/nginx/html; location / { try_files $uri $uri/ /index.html; } location /api/ { proxy_pass http://127.0.0.1:8020/; } location = /privacy-sentinel { proxy_pass http://127.0.0.1:8082/; } } }'
        call(['docker', 'exec', '-i', web, 'sh', '-c', 'cat > /tmp/rehearsal.conf'], input=config)
        call(['docker', 'exec', '-d', web, 'nginx', '-c', '/tmp/rehearsal.conf', '-g', 'daemon off;'])
        stage('proxy-privacy-sentinel')
        call(['docker', 'exec', '-d', app, 'sh', '-c', 'exec python /recovery/probe.py --sentinel-serve >/dev/null 2>&1'])
        print(call(['docker', 'exec', app, 'python', '/recovery/probe.py', '--sentinel-check']).decode().strip())
        info = json.loads(call(['docker', 'inspect', web]))[0]
        require(info['HostConfig']['ReadonlyRootfs'] and info['HostConfig']['LogConfig']['Type'] == 'none')
        require(all(info['HostConfig']['Tmpfs'].get(p) for p in ('/tmp', '/var/cache/nginx', '/var/run')))
        require(not info['HostConfig']['PortBindings'])
        require(not call(['docker', 'exec', web, 'find', '/var/cache/nginx', '-type', 'f']).strip())
        # An attempted rootfs spill must fail independently of the nginx config.
        denied = subprocess.run(['docker', 'exec', web, 'sh', '-c', 'printf synthetic > /privacy-spill-sentinel'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        require(denied.returncode != 0)
        print('PASS nginx immutable rootfs, tmpfs cache/temp, zero cache files, disk-write rejection')
        call(['docker', 'exec', '-i', app, 'python', '/recovery/probe.py', '--old'], input=old.read_bytes())
        call(['docker', 'exec', '-d', app, 'sh', '-c', 'exec python /recovery/probe.py --serve-old >/dev/null 2>&1'])
        stage('browser-render-authenticated-reads')
        require(call(['docker', 'image', 'inspect', BROWSER_IMAGE, '--format', '{{.Id}}']).decode().strip() == BROWSER_IMAGE)
        private_session = call(['docker', 'exec', app, 'cat', '/recovery/browser-session.json'])
        print(call(['docker', 'run', '--name', browser, '-i', *common, '--network', f'container:{db}',
                    '--tmpfs', '/tmp:rw,size=512m', '--entrypoint', 'node', BROWSER_IMAGE, '-e', BROWSER_JS],
                   input=private_session).decode().strip())
        del private_session
        print(json.dumps({'result': 'PASS', 'release': sha, 'scope': 'current startup/API/config/uploads/crypto and current+preserved frontend login-render/authenticated-GET compatibility',
                          'backend_rollback': 'NOT VERIFIED', 'browser_compatibility': 'login render and authenticated GET APIs PASS'}))
        passed = True
    finally:
        for name in names:
            try:
                present = call(['docker', 'container', 'ls', '-aq', '--filter', f'name=^/{name}$']).strip()
                if not present:
                    continue
                require(call(['docker', 'inspect', name, '--format', '{{index .Config.Labels "scanaki.rehearsal"}}']).decode().strip() == nonce)
                call(['docker', 'rm', '-f', '-v', name])
                require(not call(['docker', 'container', 'ls', '-aq', '--filter', f'name=^/{name}$']).strip())
            except Exception:
                cleanup_ok = False
        if not cleanup_ok:
            stage('owned-resource-cleanup')
        require(cleanup_ok)
        if passed:
            print('PASS owned resource cleanup; no production cutover')


def old_probe():
    root = Path('/recovery/old')
    root.mkdir(mode=0o700)
    unpack(sys.stdin.buffer, root, False)
    indices = list(root.rglob('index.html'))
    require(len(indices) == 1)
    assets = indices[0].parent
    # Static HTTP verification uses a loopback-only server in the isolated namespace.
    server = subprocess.Popen([sys.executable, '-m', 'http.server', '8081', '--bind', '127.0.0.1',
                               '--directory', str(assets)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(.5)
        for port in (8080, 8081):
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/index.html', timeout=5) as response:
                html = response.read().decode()
                require(response.status == 200 and '<' in html)
            links = re.findall(r'(?:src|href)=["\']([^"\']+\.(?:js|css))["\']', html)
            require(bool(links))
            for link in links:
                require(not link.startswith('//') and ':' not in link and '..' not in PurePosixPath(link).parts)
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/' + link.lstrip('/'), timeout=5) as response:
                    data = response.read()
                    require(response.status == 200 and len(data) > 0)
                    if port == 8081:
                        require(hashlib.sha256(data).hexdigest() == digest(assets / link.lstrip('/')))
        with urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=5) as response:
            require(response.status == 200)
        print('PASS current frontend/API proxy and preserved frontend asset HTTP hashes; not browser rollback proof')
    finally:
        server.terminate()
        server.wait(timeout=10)


def sentinel_serve():
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            block = b'PRIVATE-SYNTHETIC-REHEARSAL-NOT-CUSTOMER-DATA\n' * 1024
            self.send_response(200)
            self.send_header('Content-Length', str(len(block) * 256))
            self.end_headers()
            for _ in range(256):
                self.wfile.write(block)
    HTTPServer(('127.0.0.1', 8082), Handler).serve_forever()


def sentinel_check():
    stage('proxy-large-response-integrity')
    block = b'PRIVATE-SYNTHETIC-REHEARSAL-NOT-CUSTOMER-DATA\n' * 1024
    expected = hashlib.sha256(block * 256).hexdigest()
    for attempt in range(20):
        try:
            response = urllib.request.urlopen('http://127.0.0.1:8080/privacy-sentinel', timeout=10)
            break
        except Exception:
            if attempt == 19:
                raise
            time.sleep(.1)
    with response:
        actual = hashlib.sha256()
        size = 0
        while chunk := response.read(32768):
            actual.update(chunk)
            size += len(chunk)
            time.sleep(.001)
    require(size == len(block) * 256 and actual.hexdigest() == expected)
    print(json.dumps({'synthetic_proxy_bytes': size, 'stream_integrity': 'PASS'}))


if __name__ == '__main__':
    try:
        mode = sys.argv[1:]
        if mode == ['--prepare']:
            prepare()
        elif mode == ['--api']:
            api_probe()
        elif mode == ['--old']:
            old_probe()
        elif mode == ['--private']:
            private_probe()
        elif mode == ['--serve-old']:
            serve_old()
        elif mode == ['--sentinel-serve']:
            sentinel_serve()
        elif mode == ['--sentinel-check']:
            sentinel_check()
        else:
            coordinator(mode)
    except Exception:
        print('FAIL isolated application rehearsal stage=' + STAGE + '; details suppressed', file=sys.stderr)
        sys.exit(1)
