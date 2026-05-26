"""Pytest configuration.

We don't import the Firebase admin SDK in unit tests — `app/firebase_app.py`
calls `initialize_app()` at import time which requires real credentials. Unit
tests target modules that don't touch the SDK (hotkeys, copy, LLM adapters
with mocks). Integration tests against the Firestore emulator are scaffolded
separately and skipped if the emulator isn't running.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Make `app/` importable as a top-level package.
sys.path.insert(0, str(Path(__file__).parent.parent))

os.environ.setdefault("LLM_PROVIDER", "anthropic")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-not-used")
os.environ.setdefault("TELNYX_API_KEY", "test")
os.environ.setdefault("TELNYX_PUBLIC_KEY", "")
os.environ.setdefault("TELNYX_FROM_NUMBER", "+15555550100")
os.environ.setdefault("VCARD_URL", "https://example.test/farmfriend.vcf")
os.environ.setdefault("COORDINATOR_PHONE", "+12065550100")
