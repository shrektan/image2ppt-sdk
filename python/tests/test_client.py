"""Unit tests for the image2ppt Python client.

Uses an injected fake session (no network, no extra deps) plus real Pillow images
for the compression path. Polling tests use poll_interval=0 / retry_after=0 to run
instantly.
"""

from __future__ import annotations

import io
import os

import pytest
from PIL import Image

from image2ppt import (
    AuthenticationError,
    Image2PPTClient,
    Image2PPTError,
    Image2PPTTimeoutError,
    InsufficientCreditsError,
    Job,
    JobFailedError,
    NotReadyError,
    RateLimitedError,
)
from image2ppt._compress import compress_image_for_upload


class FakeResponse:
    def __init__(self, status_code=200, json_body=None, content=b"", headers=None, raise_json=False):
        self.status_code = status_code
        self._json = json_body
        self._content = content
        self.headers = headers or {}
        self._raise_json = raise_json

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def json(self):
        if self._raise_json:
            raise ValueError("not json")
        return self._json

    def iter_content(self, chunk_size=65536):
        yield self._content

    def close(self):
        pass


class FakeSession:
    def __init__(self, handler):
        self.headers = {}
        self._handler = handler
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self._handler("POST", url, **kwargs)

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self._handler("GET", url, **kwargs)


def make_client(handler):
    return Image2PPTClient("i2p_live_test", session=FakeSession(handler))


def png_bytes(size=(8, 8), color=(120, 30, 200)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def noise_png(size, mode="RGB"):
    """A noisy (photo-like) PNG — near-incompressible as PNG, so the JPEG path
    genuinely wins. A flat-color image would hit the 'never bigger' fallback and
    stay PNG, which is correct behavior but useless for exercising compression.
    """
    w, h = size
    channels = 4 if mode == "RGBA" else 3
    img = Image.frombytes(mode, size, os.urandom(w * h * channels))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# construction
# --------------------------------------------------------------------------- #
def test_init_requires_key():
    with pytest.raises(ValueError):
        Image2PPTClient("")


def test_init_sets_auth_header():
    session = FakeSession(lambda *a, **k: FakeResponse())
    Image2PPTClient("i2p_live_abc", session=session)
    assert session.headers["Authorization"] == "Bearer i2p_live_abc"


def test_base_url_trailing_slash_stripped():
    c = make_client(lambda *a, **k: FakeResponse())
    c2 = Image2PPTClient("k", base_url="https://x.test/", session=FakeSession(lambda *a, **k: FakeResponse()))
    assert c2.base_url == "https://x.test"
    assert c.base_url == "https://image2ppt.com"


# --------------------------------------------------------------------------- #
# submit
# --------------------------------------------------------------------------- #
def test_submit_success(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())

    def handler(method, url, **kwargs):
        assert method == "POST"
        assert url.endswith("/api/v1/jobs")
        return FakeResponse(201, {"jobId": "job_1", "status": "pending", "slideCount": 1, "creditsReserved": 1})

    job = make_client(handler).submit([str(img)], locale="en", aspect_ratio="16:9")
    assert job.job_id == "job_1"
    assert job.status == "pending"
    assert job.credits_reserved == 1


def test_submit_requires_files():
    with pytest.raises(ValueError):
        make_client(lambda *a, **k: FakeResponse()).submit([])


def test_submit_auth_error(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    handler = lambda *a, **k: FakeResponse(401, {"error": {"code": "INVALID_API_KEY", "message": "bad key"}})
    with pytest.raises(AuthenticationError) as exc:
        make_client(handler).submit([str(img)])
    assert exc.value.code == "INVALID_API_KEY"
    assert exc.value.status_code == 401


def test_submit_insufficient_credits(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    handler = lambda *a, **k: FakeResponse(402, {"error": {"code": "INSUFFICIENT_CREDITS", "message": "no credits"}})
    with pytest.raises(InsufficientCreditsError):
        make_client(handler).submit([str(img)])


# --------------------------------------------------------------------------- #
# get_job / wait
# --------------------------------------------------------------------------- #
def test_get_job():
    handler = lambda *a, **k: FakeResponse(200, {"jobId": "j", "status": "processing", "progress": 40})
    job = make_client(handler).get_job("j")
    assert job.status == "processing"
    assert job.progress == 40
    assert not job.is_terminal


def test_wait_polls_until_completed():
    seq = iter([
        {"jobId": "j", "status": "processing", "progress": 10},
        {"jobId": "j", "status": "processing", "progress": 60},
        {"jobId": "j", "status": "completed", "slideCount": 2, "creditsUsed": 2, "downloadUrl": "/api/v1/jobs/j/download"},
    ])
    handler = lambda *a, **k: FakeResponse(200, next(seq))
    job = make_client(handler).wait("j", poll_interval=0)
    assert job.is_completed
    assert job.credits_used == 2


def test_wait_raises_on_failed():
    handler = lambda *a, **k: FakeResponse(200, {
        "jobId": "j", "status": "failed", "slideCount": 3, "creditsRefunded": 3,
        "error": {"code": "CONVERSION_FAILED", "message": "boom"},
    })
    with pytest.raises(JobFailedError) as exc:
        make_client(handler).wait("j", poll_interval=0)
    assert exc.value.code == "CONVERSION_FAILED"
    assert exc.value.job is not None
    assert exc.value.job.credits_refunded == 3


def test_wait_backs_off_on_429():
    responses = iter([
        FakeResponse(429, {"error": {"code": "RATE_LIMITED", "message": "slow down"}}, headers={"Retry-After": "0"}),
        FakeResponse(200, {"jobId": "j", "status": "completed"}),
    ])
    handler = lambda *a, **k: next(responses)
    job = make_client(handler).wait("j", poll_interval=0)
    assert job.is_completed


def test_wait_timeout():
    handler = lambda *a, **k: FakeResponse(200, {"jobId": "j", "status": "processing"})
    with pytest.raises(Image2PPTTimeoutError) as exc:
        make_client(handler).wait("j", poll_interval=0, timeout=0)
    assert exc.value.job_id == "j"


# --------------------------------------------------------------------------- #
# download / account
# --------------------------------------------------------------------------- #
def test_download_writes_file(tmp_path):
    out = tmp_path / "out.pptx"
    handler = lambda *a, **k: FakeResponse(200, content=b"PPTXBYTES")
    path = make_client(handler).download("j", str(out))
    assert path == str(out)
    assert out.read_bytes() == b"PPTXBYTES"


def test_download_not_ready(tmp_path):
    out = tmp_path / "out.pptx"
    handler = lambda *a, **k: FakeResponse(409, {"error": {"code": "NOT_READY", "message": "wait"}})
    with pytest.raises(NotReadyError):
        make_client(handler).download("j", str(out))


def test_account():
    handler = lambda *a, **k: FakeResponse(200, {"email": "you@example.com", "credits": 42})
    info = make_client(handler).account()
    assert info["email"] == "you@example.com"
    assert info["credits"] == 42


# --------------------------------------------------------------------------- #
# error mapping
# --------------------------------------------------------------------------- #
def test_rate_limited_carries_retry_after():
    handler = lambda *a, **k: FakeResponse(
        429, {"error": {"code": "RATE_LIMITED", "message": "slow"}}, headers={"Retry-After": "12"}
    )
    with pytest.raises(RateLimitedError) as exc:
        make_client(handler).account()
    assert exc.value.retry_after == 12.0


def test_error_envelope_non_json():
    handler = lambda *a, **k: FakeResponse(500, raise_json=True)
    with pytest.raises(Image2PPTError) as exc:
        make_client(handler).account()
    assert exc.value.status_code == 500
    assert "HTTP 500" in str(exc.value)


# --------------------------------------------------------------------------- #
# Job model
# --------------------------------------------------------------------------- #
def test_job_from_dict_maps_camelcase():
    job = Job.from_dict({"jobId": "j", "status": "completed", "creditsUsed": 5, "creditsRefunded": 1})
    assert job.job_id == "j"
    assert job.is_completed
    assert job.credits_used == 5
    assert job.credits_refunded == 1


# --------------------------------------------------------------------------- #
# compression (real Pillow)
# --------------------------------------------------------------------------- #
def test_compress_passthrough_small_png():
    raw = png_bytes((16, 16))
    out, mime = compress_image_for_upload(raw, "image/png")
    assert out == raw
    assert mime == "image/png"


def test_compress_large_image_shrinks_to_jpeg():
    raw = noise_png((2400, 1800))
    out, mime = compress_image_for_upload(raw, "image/png")
    # oversized (2400px > 2000) -> shrunk, and noise makes JPEG genuinely smaller.
    assert mime == "image/jpeg"
    assert len(out) < len(raw)
    with Image.open(io.BytesIO(out)) as img:
        assert max(img.size) <= 2000


def test_compress_transparent_flattened_to_jpeg():
    raw = noise_png((2400, 800), mode="RGBA")
    out, mime = compress_image_for_upload(raw, "image/png")
    assert mime == "image/jpeg"
    with Image.open(io.BytesIO(out)) as img:
        assert img.mode == "RGB"  # alpha flattened onto white
