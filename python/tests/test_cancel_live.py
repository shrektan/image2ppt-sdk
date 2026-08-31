"""Opt-in production contract test for graceful cancellation.

This test is deliberately skipped by default. It only sends a live request when
both IMAGE2PPT_RUN_PAID_E2E=1 and IMAGE2PPT_E2E_API_KEY are set. The key and job
identifier are never written to test output or to disk.
"""

from __future__ import annotations

import os
import time
import zipfile
from contextlib import suppress
from pathlib import Path

import pytest
import requests
from PIL import Image

from image2ppt import Image2PPTClient, Image2PPTError

PAGE_COUNT = 25
POLL_INTERVAL_SECONDS = 2
START_TIMEOUT_SECONDS = 180
SETTLE_TIMEOUT_SECONDS = 600

_enabled = os.environ.get("IMAGE2PPT_RUN_PAID_E2E") == "1"
_api_key = os.environ.get("IMAGE2PPT_E2E_API_KEY")

pytestmark = [
    pytest.mark.paid_e2e,
    pytest.mark.skipif(
        not (_enabled and _api_key),
        reason=(
            "set IMAGE2PPT_RUN_PAID_E2E=1 and IMAGE2PPT_E2E_API_KEY to run the paid live test"
        ),
    ),
]


def _write_images(directory: Path) -> list[str]:
    paths: list[str] = []
    for index in range(PAGE_COUNT):
        path = directory / f"page-{index + 1:02d}.png"
        Image.new(
            "RGB", (64, 64), (index * 7 % 256, index * 13 % 256, index * 17 % 256)
        ).save(path)
        paths.append(str(path))
    return paths


def _slide_count(pptx_path: Path) -> int:
    with zipfile.ZipFile(pptx_path) as archive:
        return sum(
            name.startswith("ppt/slides/slide") and name.endswith(".xml")
            for name in archive.namelist()
        )


def _wait_until_started(client: Image2PPTClient, job_id: str) -> None:
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        snapshot = client.get_job(job_id)
        progress = snapshot.progress
        assert progress is not None
        if progress > 0:
            return
        if snapshot.status in {"completed", "failed"}:
            pytest.fail(
                "job reached a terminal state before cancellation could be requested"
            )
        time.sleep(POLL_INTERVAL_SECONDS)
    pytest.fail("job did not start before the cancellation deadline")


def test_cancelled_job_exports_only_retained_pages(tmp_path: Path) -> None:
    """Submit 25 pages, cancel after work starts, and verify the partial deck."""
    client = Image2PPTClient(_api_key or "")
    job_id: str | None = None
    cancellation_requested = False

    try:
        job = client.submit(_write_images(tmp_path))
        job_id = job.job_id

        _wait_until_started(client, job_id)

        result = client.cancel(job_id)
        cancellation_requested = result.cancellation_requested
        assert result.cancellation_requested

        completed = client.wait(
            job_id,
            poll_interval=POLL_INTERVAL_SECONDS,
            timeout=SETTLE_TIMEOUT_SECONDS,
        )
        assert completed.status == "completed"
        assert completed.cancellation_requested
        credits_used = completed.credits_used
        credits_refunded = completed.credits_refunded
        assert credits_used is not None
        assert credits_refunded is not None
        assert credits_used + credits_refunded == PAGE_COUNT

        destination = tmp_path / "partial-result.pptx"
        _ = client.download(completed.job_id, str(destination))
        retained_pages = _slide_count(destination)
        assert 0 < retained_pages < PAGE_COUNT
        assert retained_pages == credits_used
    finally:
        if job_id and not cancellation_requested:
            # A test failure must not leave the rest of a paid batch running.
            with suppress(Image2PPTError, requests.RequestException):
                _ = client.cancel(job_id)
