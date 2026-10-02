#!/usr/bin/env python3
"""RustFS 1.0.0 chart ignores non-mTLS HTTPS probe values; narrow renderer."""
import sys
manifest = sys.stdin.read()
# Upstream 1.0.0 hardcodes HTTP unless mTLS is enabled. The TLS-only profile
# mounts native server TLS without requiring client certificates.
if manifest.count('scheme: HTTP\n') != 2:
    sys.exit('RustFS probe contract changed; review upstream chart before applying')
sys.stdout.write(manifest.replace('scheme: HTTP\n', 'scheme: HTTPS\n'))
