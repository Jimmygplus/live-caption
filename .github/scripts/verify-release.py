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


FILES_BY_FORMAT = {1: FILES, 2: FILES | {
    'session-state.js', 'room-state.js', 'viewport-state.js',
    'media-capture.js', 'room-transport.js', 'design-tokens.css',
}}

# Format 3 keeps the format 1 site at the root and adds the built preview
# under next/: its page plus content-hashed scripts, styles, fonts and the
# audio worklet. Those names change with every build, so they are checked by
# shape: one level of assets, no source maps, nothing else.
PREVIEW_ENTRY = 'next/index.html'
PREVIEW_ASSET = re.compile(r'next/assets/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.(?:js|css|woff2|woff)')
PREVIEW_DIRS = {'next', 'next/assets'}
PREVIEW_LIMIT = 64
FORMATS = {1, 2, 3}


def reviewed_names(version, names):
    if version in FILES_BY_FORMAT:
        return names == FILES_BY_FORMAT[version]
    preview = names - FILES
    return (FILES <= names and PREVIEW_ENTRY in preview and len(preview) <= PREVIEW_LIMIT
            and all(name == PREVIEW_ENTRY or PREVIEW_ASSET.fullmatch(name) for name in preview))


def validate_manifest(manifest):
    if set(manifest) != {'format', 'source_commit', 'release_commit', 'files'} or type(manifest['format']) is not int or manifest['format'] not in FORMATS:
        raise ValueError('Unsupported release manifest')
    for name in ('source_commit', 'release_commit'):
        if not isinstance(manifest[name], str) or not re.fullmatch(r'[0-9a-f]{40}', manifest[name]):
            raise ValueError('Invalid commit reference')
    if not isinstance(manifest['files'], dict) or not reviewed_names(manifest['format'], set(manifest['files'])):
        raise ValueError('Release must contain only reviewed website files')
    if any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v) for v in manifest['files'].values()):
        raise ValueError('Invalid file hash')


def site_files(site, version):
    """Every regular file under site/, as relative paths; links fail."""
    files, dirs = set(), set()
    for path in site.rglob('*'):
        name = path.relative_to(site).as_posix()
        if path.is_symlink():
            raise ValueError('Release links are not allowed')
        if path.is_dir():
            dirs.add(name)
        elif path.is_file():
            files.add(name)
        else:
            raise ValueError('Unexpected release contents')
    if dirs - (PREVIEW_DIRS if version == 3 else set()):
        raise ValueError('Unexpected release directories')
    return files


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
    if site_files(site, manifest['format']) != set(manifest['files']):
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
        print(f"Verified all {len(manifest['files'])} website files; no application repository checkout or backend files.")
