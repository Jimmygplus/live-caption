import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verify_release', Path(__file__).with_name('verify-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'site').mkdir()
        self.manifest = {'format': 1, 'source_commit': 'a' * 40, 'release_commit': 'b' * 40,
                         'files': {name: hashlib.sha256(b'public fixture').hexdigest() for name in module.FILES}}
        for name in module.FILES:
            (self.root / 'site' / name).write_bytes(b'public fixture')
        (self.root / 'release.json').write_text(json.dumps({k: v for k, v in self.manifest.items() if k != 'release_commit'}))

    def test_valid_release(self):
        module.verify(self.manifest, self.root)

    def test_modified_bytes_fail(self):
        (self.root / 'site/app.js').write_text('changed')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_private_file_or_source_tree_fails(self):
        (self.root / 'server.js').write_text('private fixture')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_extra_site_file_fails(self):
        (self.root / 'site/.env').write_text('private fixture')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_symlink_fails_even_with_matching_bytes(self):
        (self.root / 'site/app.js').unlink()
        (self.root / 'site/app.js').symlink_to('input.js')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_manifest_rejects_paths_and_unpinned_refs(self):
        for changed in ({'release_commit': 'main'}, {'files': {'../server.js': 'a' * 64}}):
            manifest = copy.deepcopy(self.manifest)
            manifest.update(changed)
            with self.assertRaises(ValueError): module.validate_manifest(manifest)

    def test_release_metadata_must_match(self):
        self.manifest['source_commit'] = 'c' * 40
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_format_two_adds_only_reviewed_foundation_assets(self):
        self.manifest['format'] = 2
        for name in module.FILES_BY_FORMAT[2] - module.FILES:
            (self.root / 'site' / name).write_bytes(b'public fixture')
            self.manifest['files'][name] = hashlib.sha256(b'public fixture').hexdigest()
        (self.root / 'release.json').write_text(json.dumps({k: v for k, v in self.manifest.items() if k != 'release_commit'}))
        module.verify(self.manifest, self.root)
        (self.root / 'site/room-transport.js').write_text('changed')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_formats_do_not_allow_mixed_or_unknown_asset_sets(self):
        for version in (True, 0, 3, 4, '2', 2):
            manifest = copy.deepcopy(self.manifest)
            manifest['format'] = version
            with self.assertRaises(ValueError): module.validate_manifest(manifest)

    PREVIEW = ('next/index.html', 'next/assets/index-DzHZgl2o.js', 'next/assets/index-CpX-6bfN.css',
               'next/assets/pcm-worklet-BA2lCtD0.js', 'next/assets/newsreader-latin-600-normal-30OJ_TG_.woff2')

    def add_preview(self, names=PREVIEW):
        self.manifest['format'] = 3
        for name in names:
            path = self.root / 'site' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'public fixture')
            self.manifest['files'][name] = hashlib.sha256(b'public fixture').hexdigest()
        (self.root / 'release.json').write_text(json.dumps({k: v for k, v in self.manifest.items() if k != 'release_commit'}))

    def test_format_three_adds_the_built_preview_under_next(self):
        self.add_preview()
        module.verify(self.manifest, self.root)
        (self.root / 'site/next/assets/index-DzHZgl2o.js').write_text('changed')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_format_three_keeps_every_root_file_and_needs_the_preview_page(self):
        self.add_preview(self.PREVIEW[1:])
        with self.assertRaises(ValueError): module.validate_manifest(self.manifest)
        manifest = copy.deepcopy(self.manifest)
        manifest['files']['next/index.html'] = 'a' * 64
        del manifest['files']['app.js']
        with self.assertRaises(ValueError): module.validate_manifest(manifest)

    def test_format_three_rejects_other_names_maps_and_paths(self):
        for name in ('next/assets/index.js.map', 'next/server.js', 'next/assets/../app.js', 'next/assets/sub/a.js',
                     'next/assets/.env', 'next/src/main.tsx', 'other/index.html', 'next/assets/a.html'):
            manifest = copy.deepcopy(self.manifest)
            manifest['format'] = 3
            manifest['files']['next/index.html'] = 'a' * 64
            manifest['files'][name] = 'a' * 64
            with self.assertRaises(ValueError, msg=name): module.validate_manifest(manifest)

    def test_format_three_rejects_unlisted_files_directories_and_links(self):
        self.add_preview()
        (self.root / 'site/next/assets/extra-abc.js').write_text('not in the manifest')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)
        (self.root / 'site/next/assets/extra-abc.js').unlink()
        (self.root / 'site/next/assets/deeper').mkdir()
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)
        (self.root / 'site/next/assets/deeper').rmdir()
        (self.root / 'site/next/assets/index-DzHZgl2o.js').unlink()
        (self.root / 'site/next/assets/index-DzHZgl2o.js').symlink_to('../../app.js')
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)

    def test_directories_are_refused_before_format_three(self):
        (self.root / 'site/next').mkdir()
        with self.assertRaises(ValueError): module.verify(self.manifest, self.root)
