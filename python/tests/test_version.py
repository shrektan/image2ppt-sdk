"""The package version must match the one that actually gets published.

These drifted apart once (``__version__`` said 0.1.0 while the built package was
0.1.1), which makes a bug report's version line useless. pyproject.toml is the
release number; ``__version__`` must follow it.
"""

from __future__ import annotations

import re
from pathlib import Path

import image2ppt


def test_dunder_version_matches_pyproject():
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    declared = re.search(r'^version = "([^"]+)"', pyproject, re.MULTILINE)
    assert declared is not None, "no version field in pyproject.toml"
    assert image2ppt.__version__ == declared.group(1)
