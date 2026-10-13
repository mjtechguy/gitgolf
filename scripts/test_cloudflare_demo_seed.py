import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
from cloudflare_demo_manifest import read_manifest

spec = importlib.util.spec_from_file_location('demo_seed', Path(__file__).with_name('cloudflare-demo-seed.py'))
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class DemoSeedTests(unittest.TestCase):
    def test_repeatable_manifest_pins_three_owner_inventories(self):
        path=Path(__file__).resolve().parents[1]/'deploy/demo/demo.json'
        manifest=read_manifest(path)
        self.assertEqual({owner:sum(r['owner']==owner for r in manifest['repositories']) for owner in ['mj','mj-platform','mj-labs']},{'mj':10,'mj-platform':3,'mj-labs':3})
        for field,value in [('upstream','https://user:secret@github.com/org/repo'),('commit','main'),('owner','unknown')]:
            changed=json.loads(path.read_text());changed['repositories'][0][field]=value
            with tempfile.TemporaryDirectory() as d:
                bad=Path(d)/'manifest.json';bad.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):read_manifest(bad)

    def test_public_clone_never_inherits_provider_authority(self):
        public = seed.git_environment()
        private = seed.git_environment('provider-token')
        self.assertEqual(private['GIT_CONFIG_VALUE_3'], 'Authorization: Bearer provider-token')
        self.assertFalse(any('provider-token' in value for value in public.values()))
        self.assertEqual(public['GIT_CONFIG_GLOBAL'], '/dev/null')
        for value in ['bad\ntoken', 'bad token', 'a' * 2049]:
            with self.assertRaises(ValueError):
                seed.git_environment(value)

    def test_bounded_public_inventory_has_unique_safe_destinations(self):
        self.assertEqual(len(seed.SOURCES), 10)
        self.assertEqual(len({name for name, _ in seed.SOURCES}), 10)
        for name, upstream in seed.SOURCES:
            self.assertRegex(name, r'^[a-z][a-z0-9-]+$')
            self.assertRegex(upstream, r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')


if __name__ == '__main__':
    unittest.main()
