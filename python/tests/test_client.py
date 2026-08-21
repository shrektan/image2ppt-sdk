"""Unit tests for the image2ppt Python client.

Uses an injected fake session (no network, no extra deps) plus real Pillow images
for the compression path. Polling tests use poll_interval=0 / retry_after=0 to run
instantly.
"""

from __future__ import annotations

import io
import os

import pytest
import requests
from PIL import Image

from image2ppt import (
    MAX_PAGES_PER_JOB,
    MAX_UPLOAD_BYTES,
    AuthenticationError,
    Image2PPTClient,
    Image2PPTError,
    Image2PPTTimeoutError,
    InsufficientCreditsError,
    InvalidFileError,
    Job,
    JobFailedError,
    JobNotFoundError,
    NotReadyError,
    RateLimitedError,
    TooManySlidesError,
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


def client_and_session(handler, **kwargs):
    """Client plus the fake session, for asserting on what actually got sent."""
    session = FakeSession(handler)
    return Image2PPTClient("i2p_live_test", session=session, **kwargs), session


def posted_filenames(session):
    """Filenames carried by each POST, in order: [[batch1...], [batch2...]]."""
    return [
        [entry[1][0] for entry in call[2]["files"]]
        for call in session.calls
        if call[0] == "POST"
    ]


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


def test_submit_pdf_uses_raw_handle_branch(tmp_path):
    """PDFs skip compression and upload via the open-handle branch with the pdf mime."""
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4 not-a-real-pdf-but-not-an-image")
    captured = {}

    def handler(method, url, **kwargs):
        captured["files"] = kwargs.get("files")
        return FakeResponse(201, {"jobId": "job_pdf", "status": "pending", "slideCount": 3, "creditsReserved": 3})

    job = make_client(handler).submit([str(pdf)])
    assert job.job_id == "job_pdf"
    # multipart entry: ("files", (filename, handle, mime))
    _field, (filename, _handle, mime) = captured["files"][0]
    assert filename == "doc.pdf"
    assert mime == "application/pdf"


def test_submit_corrupt_image_raises_invalid_file(tmp_path):
    """A file with an image extension but unreadable bytes surfaces as InvalidFileError,
    not a raw Pillow exception (which callers catching Image2PPTError would miss)."""
    bad = tmp_path / "broken.png"
    bad.write_bytes(b"not actually a PNG")
    with pytest.raises(InvalidFileError):
        make_client(lambda *a, **k: FakeResponse()).submit([str(bad)])


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


def test_wait_retries_transient_5xx():
    """A single transient 5xx poll is retried, not fatal — the job finishes."""
    responses = iter([
        FakeResponse(500, {"error": {"code": "STORAGE_FAILED", "message": "oops"}}),
        FakeResponse(200, {"jobId": "j", "status": "completed"}),
    ])
    handler = lambda *a, **k: next(responses)
    job = make_client(handler).wait("j", poll_interval=0)
    assert job.is_completed


def test_wait_aborts_on_client_error():
    """A 4xx during polling (job gone) is not transient — it propagates immediately."""
    handler = lambda *a, **k: FakeResponse(404, {"error": {"code": "JOB_NOT_FOUND", "message": "gone"}})
    with pytest.raises(JobNotFoundError):
        make_client(handler).wait("j", poll_interval=0)


# --------------------------------------------------------------------------- #
# convert (end-to-end: submit -> wait -> download)
# --------------------------------------------------------------------------- #
def test_convert_end_to_end(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    out = tmp_path / "out.pptx"
    responses = iter([
        FakeResponse(201, {"jobId": "job_9", "status": "pending", "slideCount": 1, "creditsReserved": 1}),
        FakeResponse(200, {"jobId": "job_9", "status": "completed", "slideCount": 1, "creditsUsed": 1,
                           "downloadUrl": "/api/v1/jobs/job_9/download"}),
        FakeResponse(200, content=b"PPTXDATA"),
    ])
    handler = lambda *a, **k: next(responses)
    job = make_client(handler).convert([str(img)], str(out), poll_interval=0)
    assert job.is_completed
    assert job.job_id == "job_9"
    assert out.read_bytes() == b"PPTXDATA"


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


def test_compress_oversized_incompressible_still_shrinks():
    """A flat-color image over 2000px is tiny as PNG, so its JPEG re-encode is not
    smaller and hits the 'never bigger' fallback. It must STILL be shrunk to
    <=2000px — the dimension guarantee wins over the byte-size fallback."""
    raw = png_bytes((3000, 2400))  # flat color -> highly compressible PNG
    out, _mime = compress_image_for_upload(raw, "image/png")
    with Image.open(io.BytesIO(out)) as img:
        assert max(img.size) <= 2000


# --------------------------------------------------------------------------- #
# upload size guard — the regression this whole feature exists for
#
# A submission over the per-request size cap does not come back as an error: the
# network layer in front of the API drops the connection mid-upload, and the
# caller sees a bare write timeout. So the only acceptable behavior is to refuse
# locally, having sent nothing. Every test here asserts on session.calls.
# --------------------------------------------------------------------------- #
def sparse_file(tmp_path, name, size):
    """A file of exactly ``size`` bytes, allocated sparsely (instant, no real I/O).

    Used with a .pdf name so the client measures it with os.path.getsize and never
    reads or compresses it.
    """
    path = tmp_path / name
    with open(path, "wb") as fh:
        fh.truncate(size)
    return str(path)


def exploding_handler(*_args, **_kwargs):
    raise AssertionError("no HTTP request should have been made")


def test_submit_refuses_oversized_batch_without_sending_anything(tmp_path):
    """Two individually-legal files that add up past the request cap: rejected
    before a connection is opened."""
    half = MAX_UPLOAD_BYTES // 2
    files = [
        sparse_file(tmp_path, "a.pdf", half),
        sparse_file(tmp_path, "b.pdf", half + 1),
    ]
    client, session = client_and_session(exploding_handler)

    with pytest.raises(InvalidFileError) as exc:
        client.submit(files)

    assert exc.value.code == "PAYLOAD_TOO_LARGE"
    assert len(session.calls) == 0  # nothing went on the wire


def test_submit_refuses_too_many_pages_without_sending_anything(tmp_path):
    paths = []
    for i in range(MAX_PAGES_PER_JOB + 1):
        img = tmp_path / f"p{i:03d}.png"
        img.write_bytes(png_bytes())
        paths.append(str(img))
    client, session = client_and_session(exploding_handler)

    with pytest.raises(TooManySlidesError):
        client.submit(paths)

    assert len(session.calls) == 0


def test_submit_within_limits_still_sends_exactly_one_request(tmp_path):
    """The guard must not get in the way of a normal submission."""
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    client, session = client_and_session(
        lambda *a, **k: FakeResponse(201, {"jobId": "j", "status": "pending"})
    )

    client.submit([str(img)])

    assert posted_filenames(session) == [["a.png"]]


# --------------------------------------------------------------------------- #
# submit_all / convert_all — automatic batching
# --------------------------------------------------------------------------- #
def make_images(tmp_path, count):
    paths = []
    for i in range(count):
        img = tmp_path / f"p{i:03d}.png"
        img.write_bytes(png_bytes())
        paths.append(str(img))
    return paths


def test_submit_all_splits_past_the_page_limit_into_two_jobs(tmp_path):
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    jobs_seq = iter(["job_a", "job_b"])
    handler = lambda *a, **k: FakeResponse(201, {"jobId": next(jobs_seq), "status": "pending"})
    client, session = client_and_session(handler)

    jobs = client.submit_all(paths)

    assert [job.job_id for job in jobs] == ["job_a", "job_b"]
    sent = posted_filenames(session)
    assert len(sent) == 2
    assert sent[0] == [f"p{i:03d}.png" for i in range(MAX_PAGES_PER_JOB)]
    assert sent[1] == [f"p{MAX_PAGES_PER_JOB:03d}.png"]


def test_submit_all_gives_a_pdf_its_own_job(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    doc = tmp_path / "doc.pdf"
    doc.write_bytes(b"%PDF-1.4 tiny")
    handler = lambda *a, **k: FakeResponse(201, {"jobId": "j", "status": "pending"})
    client, session = client_and_session(handler)

    client.submit_all([str(img), str(doc)])

    assert posted_filenames(session) == [["a.png"], ["doc.pdf"]]


def test_submit_all_single_batch_behaves_like_submit(tmp_path):
    paths = make_images(tmp_path, 3)
    handler = lambda *a, **k: FakeResponse(201, {"jobId": "j", "status": "pending"})
    client, session = client_and_session(handler)

    jobs = client.submit_all(paths)

    assert len(jobs) == 1
    assert len(posted_filenames(session)) == 1


def test_convert_all_writes_one_numbered_pptx_per_batch(tmp_path):
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    out_dir = tmp_path / "decks"
    responses = iter([
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
        FakeResponse(201, {"jobId": "job_b", "status": "pending"}),
        FakeResponse(200, {"jobId": "job_a", "status": "completed"}),
        FakeResponse(200, content=b"DECK-A"),
        FakeResponse(200, {"jobId": "job_b", "status": "completed"}),
        FakeResponse(200, content=b"DECK-B"),
    ])
    handler = lambda *a, **k: next(responses)

    written = make_client(handler).convert_all(paths, str(out_dir), poll_interval=0)

    assert written == [str(out_dir / "part-01.pptx"), str(out_dir / "part-02.pptx")]
    assert (out_dir / "part-01.pptx").read_bytes() == b"DECK-A"
    assert (out_dir / "part-02.pptx").read_bytes() == b"DECK-B"


# --------------------------------------------------------------------------- #
# upload retry — safe only for a connection that died mid-upload
# --------------------------------------------------------------------------- #
def test_submit_retries_a_connection_dropped_mid_upload(tmp_path):
    """The body never arrived, so no job was created and nothing was charged."""
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    attempts = {"n": 0}

    def handler(*_args, **_kwargs):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise requests.exceptions.ConnectionError(
                "('Connection aborted.', TimeoutError('The write operation timed out'))"
            )
        return FakeResponse(201, {"jobId": "job_retry", "status": "pending"})

    client, session = client_and_session(handler)
    client._upload_retry_backoff = 0  # no real sleeping in tests

    job = client.submit([str(img)])

    assert job.job_id == "job_retry"
    assert len(posted_filenames(session)) == 2


def test_submit_never_retries_a_read_timeout(tmp_path):
    """The body WAS sent, so the job may exist with credits reserved. Retrying
    would submit the same files twice and charge twice."""
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())

    def handler(*_args, **_kwargs):
        raise requests.exceptions.ReadTimeout("timed out waiting for the response")

    client, session = client_and_session(handler)
    client._upload_retry_backoff = 0

    with pytest.raises(requests.exceptions.ReadTimeout):
        client.submit([str(img)])

    assert len(posted_filenames(session)) == 1  # exactly one attempt


def test_submit_gives_up_after_max_upload_retries(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())

    def handler(*_args, **_kwargs):
        raise requests.exceptions.ConnectionError("connection reset")

    client, session = client_and_session(handler, max_upload_retries=1)
    client._upload_retry_backoff = 0

    with pytest.raises(requests.exceptions.ConnectionError):
        client.submit([str(img)])

    assert len(posted_filenames(session)) == 2  # first attempt + 1 retry
