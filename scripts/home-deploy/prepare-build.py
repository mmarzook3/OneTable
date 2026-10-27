#!/usr/bin/env python3
"""Build the bridge with the existing backend base, without registry credentials."""
from pathlib import Path
import shutil
import subprocess


def prepare(root):
    destination = root / 'tmp/home-build'
    destination.mkdir(parents=True, exist_ok=False)
    # CI uses a clean checkout. Copy only tracked application inputs, never host secrets.
    tracked = subprocess.check_output(['git', 'ls-files', '-z', 'back', 'ws-bridge'], cwd=root).decode().split('\0')
    for name in filter(None, tracked):
        source = root / name
        if source.is_symlink():
            raise ValueError('Symlink build inputs require review')
        relative = Path(name)
        target = destination / ('bridge' if relative.parts[0] == 'ws-bridge' else 'back') / Path(*relative.parts[1:])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    backend = (root / 'back/Dockerfile').read_text()
    bridge = (root / 'ws-bridge/Dockerfile').read_text()
    # Fail closed if upstream layout changes; do not silently change the runtime contract.
    if 'COPY requirements.txt .' not in backend or 'COPY . .' not in backend or 'FROM pos-back\n' not in bridge:
        raise ValueError('Review changed Dockerfiles before packaging HOME bridge')
    backend = backend.replace('COPY requirements.txt .', 'COPY back/requirements.txt .')
    backend = backend.replace('COPY . .', 'COPY back/ .')
    bridge = bridge.replace('FROM pos-back\n', '')
    bridge = bridge.replace('COPY requirements.txt .', 'COPY bridge/requirements.txt .')
    bridge = bridge.replace('COPY main.py .', 'COPY bridge/main.py .')
    (destination / 'Dockerfile').write_text(backend + '\n' + bridge)


if __name__ == '__main__':
    prepare(Path(__file__).resolve().parents[2])
