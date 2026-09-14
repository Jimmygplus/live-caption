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
