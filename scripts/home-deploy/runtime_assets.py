#!/usr/bin/env python3
"""Fetch a pinned own-repository release asset; never access marketing repositories."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import os

LIMIT = 2 * 1024**3


def unpack(archive_path, destination, digest, manifest):
    hasher = hashlib.sha256()
    with archive_path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024**2), b''):
            hasher.update(chunk)
    if hasher.hexdigest() != digest:
        raise ValueError('Runtime asset SHA256 mismatch')
    seen = set()
    total = 0
    with tarfile.open(archive_path, 'r:*') as archive:
        for index, member in enumerate(archive):
            name = member.name.removeprefix('./')
            if name in ('', '.') and member.isdir():
                continue
            path = PurePosixPath(name)
            if (index > 50000 or not path.parts or path.is_absolute() or
                    '..' in path.parts or '\\' in name or ':' in name or
                    path.parts[0] not in ('sites', 'downloads') or
                    not (member.isfile() or member.isdir())):
                raise ValueError('Unsafe runtime asset archive member')
            total += member.size
            if total > LIMIT:
                raise ValueError('Runtime asset archive exceeds expanded size limit')
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if name in seen:
                raise ValueError('Duplicate runtime asset file')
            seen.add(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
    # Same manifest/index and placeholder contract as sync-all-marketing-sites.sh,
    # without invoking its cross-repository fetch or sibling-build fallbacks.
    for site in manifest['sites']:
        if site['slug'] in manifest.get('excludedSlugs', []):
            continue
        parts = [site['slug']]
        if site.get('deploySubpath'):
            parts.append(site['deploySubpath'])
        if any(not re.fullmatch(r'[A-Za-z0-9_-]+', part) for part in parts):
            raise ValueError('Unsafe manifest path')
        index = destination / 'sites' / Path(*parts) / 'index.html'
        if not index.is_file() or 'bundle not loaded' in index.read_text():
            raise ValueError('Missing or placeholder marketing index: ' + site['slug'])
    if not any(p.is_file() and p.stat().st_size > 0 for p in (destination / 'downloads').rglob('*.apk')):
        raise ValueError('Runtime asset snapshot has no Android APK')


def main():
    root = Path(__file__).resolve().parents[2]
    metadata = json.loads((root / 'config/scanaki-runtime-assets.json').read_text())
    if (set(metadata) != {'release_tag', 'asset', 'sha256'} or
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', metadata['release_tag']) or
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.tar(?:\.gz)?', metadata['asset']) or
            not re.fullmatch(r'[0-9a-f]{64}', metadata['sha256'])):
        raise ValueError('Invalid pinned runtime asset metadata')
    repository = os.environ['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid own repository')
    (root / 'tmp').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='runtime-assets-', dir=root / 'tmp') as temporary:
        staging = Path(temporary)
        subprocess.run(['gh', 'release', 'download', metadata['release_tag'], '--repo', repository,
                        '--pattern', metadata['asset'], '--dir', str(staging)], check=True)
        archive = staging / metadata['asset']
        if archive.stat().st_size > LIMIT:
            raise ValueError('Runtime asset download exceeds size limit')
        content = staging / 'content'
        content.mkdir()
        unpack(archive, content, metadata['sha256'],
               json.loads((root / 'config/marketing-sites.json').read_text()))
        shutil.copytree(content / 'sites', root / 'front/sites', dirs_exist_ok=True)
        shutil.copytree(content / 'downloads', root / 'front/public/downloads', dirs_exist_ok=True)


if __name__ == '__main__':
    main()
