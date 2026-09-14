"""Verify the pinned release before any files are uploaded to Pages."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

FILES = {
    'index.html', 'v1.html', 'input.html', 'app.js', 'input.js', 'v2.css',
    'styles.css', 'input.css', 'audio-check.js', 'audio-source.js',
    'audience-crypto.js', 'caption-state.js', 'font-size.js', 'glossaries.json',
    'join-crypto.js', 'pcm-worklet.js', 'qr.js', 'relay-config.js',
    'trial-code.js', 'trial-config.js',
}


def validate_manifest(manifest):
    if set(manifest) != {'format', 'source_commit', 'release_commit', 'files'} or manifest['format'] != 1:
        raise ValueError('Unsupported release manifest')
    for name in ('source_commit', 'release_commit'):
        if not isinstance(manifest[name], str) or not re.fullmatch(r'[0-9a-f]{40}', manifest[name]):
            raise ValueError('Invalid commit reference')
    if set(manifest['files']) != FILES:
        raise ValueError('Release must contain only reviewed website files')
    if any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in manifest['files'].values()):
        raise ValueError('Invalid file hash')


def verify(manifest, release):
    validate_manifest(manifest)
    release = Path(release)
    # Checkout metadata remains outside the published site directory.
    if {p.name for p in release.iterdir()} - {'.git'} != {'site', 'release.json'}:
        raise ValueError('Unexpected release contents')
    if (release / 'site').is_symlink() or (release / 'release.json').is_symlink():
        raise ValueError('Release links are not allowed')
    if json.loads((release / 'release.json').read_text()) != {k: v for k, v in manifest.items() if k != 'release_commit'}:
        raise ValueError('Source release does not match the publication manifest')
    site = release / 'site'
    if {p.name for p in site.iterdir()} != FILES:
        raise ValueError('Missing or extra site files')
    for name, expected in manifest['files'].items():
        path = site / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Website integrity check failed: ' + name)


if __name__ == '__main__':
    manifest = json.loads(Path('release.json').read_text())
    validate_manifest(manifest)
    if sys.argv[1] == 'prepare':
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('commit=' + manifest['release_commit'] + '\n')
    else:
        verify(manifest, '_release')
        print('Verified all 20 website files; no application repository checkout or backend files.')
