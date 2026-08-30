"""The package version, in one place.

It lives here rather than in ``__init__`` because ``client`` needs it too (for the
``User-Agent`` header) and ``__init__`` imports ``client`` — reading it from the
package would be a circular import. ``tests/test_version.py`` keeps it in step with
``pyproject.toml``.
"""

from __future__ import annotations

__version__ = "0.4.0"
