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
    MAX_FILE_BYTES,
    MAX_UPLOAD_BYTES,
    MAX_PAGES_PER_JOB,
    AuthenticationError,
    Image2PPTClient,
    Image2PPTError,
    Image2PPTTimeoutError,
    InsufficientCreditsError,
    InvalidAspectRatioError,
    InvalidFileError,
    Job,
    JobFailedError,
    JobNotFoundError,
    MalformedUploadError,
    NoFilesError,
    NotReadyError,
    PageRateExceededError,
    RateLimitedError,
    TooManySlidesError,
    UploadAbortedError,
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


def test_submit_upload_aborted_maps_to_its_own_type(tmp_path):
    """400 UPLOAD_ABORTED must be distinguishable — it is the one upload failure
    the caller may safely resend (the server states it took nothing)."""
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    handler = lambda *a, **k: FakeResponse(
        400, {"error": {"code": "UPLOAD_ABORTED", "message": "body incomplete"}}
    )
    with pytest.raises(UploadAbortedError) as exc:
        make_client(handler).submit([str(img)])
    assert exc.value.code == "UPLOAD_ABORTED"
    assert exc.value.status_code == 400


def test_submit_malformed_upload_maps_to_its_own_type(tmp_path):
    """400 MALFORMED_UPLOAD is the opposite advice — resending identical bytes is
    pointless — so it must not share a type with UPLOAD_ABORTED."""
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    handler = lambda *a, **k: FakeResponse(
        400, {"error": {"code": "MALFORMED_UPLOAD", "message": "bad multipart"}}
    )
    with pytest.raises(MalformedUploadError) as exc:
        make_client(handler).submit([str(img)])
    assert exc.value.code == "MALFORMED_UPLOAD"
    assert not isinstance(exc.value, UploadAbortedError)


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


def test_wait_backs_off_on_429(monkeypatch):
    responses = iter([
        FakeResponse(429, {"error": {"code": "RATE_LIMITED", "message": "slow down"}}, headers={"Retry-After": "0"}),
        FakeResponse(200, {"jobId": "j", "status": "completed"}),
    ])
    handler = lambda *a, **k: next(responses)
    # Fake clock: the header says 0, but the client floors it (see the floor tests
    # below), so a real sleep would cost a second of suite time for nothing.
    slept = []
    monkeypatch.setattr("image2ppt.client.time.sleep", slept.append)
    job = make_client(handler).wait("j", poll_interval=0)
    assert job.is_completed
    assert slept == [1.0]  # floored, not the literal 0 from the header


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
# a failed submission is NOT retried
#
# This looks like a missing feature; it is a deliberate one. A ConnectionError
# proves only that the exchange broke — the server may have received the whole
# body, created the job and reserved credits, and then lost the connection while
# answering. Retrying that case charges the user twice. Nothing here can tell the
# two apart without an idempotency key the API does not offer, so the error goes
# to the caller untouched. These tests exist so nobody quietly adds the retry back.
# --------------------------------------------------------------------------- #
def test_submit_does_not_retry_a_broken_connection(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    attempts = {"n": 0}

    def handler(*_args, **_kwargs):
        attempts["n"] += 1
        raise requests.exceptions.ConnectionError(
            "('Connection aborted.', TimeoutError('The write operation timed out'))"
        )

    client, session = client_and_session(handler)

    with pytest.raises(requests.exceptions.ConnectionError):
        client.submit([str(img)])

    assert attempts["n"] == 1  # tried exactly once
    assert len(posted_filenames(session)) == 1


def test_submit_does_not_retry_a_read_timeout(tmp_path):
    """The body was sent, so the job may exist with credits reserved."""
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())

    def handler(*_args, **_kwargs):
        raise requests.exceptions.ReadTimeout("timed out waiting for the response")

    client, session = client_and_session(handler)

    with pytest.raises(requests.exceptions.ReadTimeout):
        client.submit([str(img)])

    assert len(posted_filenames(session)) == 1


def test_submit_all_does_not_retry_a_broken_connection_either(tmp_path):
    """And the jobs already created still come back on the exception."""
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    state = {"n": 0}

    def handler(*_args, **_kwargs):
        state["n"] += 1
        if state["n"] == 1:
            return FakeResponse(201, {"jobId": "job_a", "status": "pending"})
        raise requests.exceptions.ConnectionError("connection reset")

    client, session = client_and_session(handler)

    with pytest.raises(requests.exceptions.ConnectionError) as exc:
        client.submit_all(paths)

    assert len(posted_filenames(session)) == 2  # batch 1, then batch 2 once
    assert [job.job_id for job in exc.value.submitted_jobs] == ["job_a"]


# --------------------------------------------------------------------------- #
# submit_all rate limiting
#
# A pile big enough to need batching is a pile big enough to hit the per-minute
# page quota, so a 429 mid-pile is the normal case, not an exception. If it were
# raised, batching would only trade one failure for another. Retry-After is 0 in
# these tests so nothing actually sleeps.
# --------------------------------------------------------------------------- #
def rate_limited_response(retry_after="0"):
    return FakeResponse(
        429,
        {"error": {"code": "RATE_LIMITED", "message": "slow down"}},
        headers={"Retry-After": retry_after},
    )


def test_submit_all_waits_out_a_rate_limit_and_retries_the_same_batch(
    tmp_path, monkeypatch
):
    monkeypatch.setattr("image2ppt.client.time.sleep", lambda _s: None)
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    responses = iter([
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
        rate_limited_response(),  # second batch bounces off the per-minute quota
        FakeResponse(201, {"jobId": "job_b", "status": "pending"}),
    ])
    handler = lambda *a, **k: next(responses)
    client, session = client_and_session(handler)

    jobs = client.submit_all(paths)

    assert [job.job_id for job in jobs] == ["job_a", "job_b"]
    sent = posted_filenames(session)
    assert len(sent) == 3  # batch 1, the rejected batch 2, then batch 2 again
    assert sent[1] == sent[2]  # the retry carried exactly the same files


def test_submit_all_hands_back_created_jobs_when_it_gives_up(tmp_path):
    """Giving up must not strand the jobs already created — they are running and
    their credits are already reserved."""
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    responses = iter([
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
        rate_limited_response(),
    ])
    handler = lambda *a, **k: next(responses)
    # No waiting budget at all: the first 429 ends it.
    client, session = client_and_session(handler, rate_limit_max_wait=0)

    with pytest.raises(RateLimitedError) as exc:
        client.submit_all(paths)

    assert [job.job_id for job in exc.value.submitted_jobs] == ["job_a"]
    assert len(posted_filenames(session)) == 2  # no pointless extra attempt


def test_submit_all_uses_a_default_wait_when_the_server_sends_no_retry_after(
    tmp_path, monkeypatch
):
    """Without a Retry-After header the client still waits rather than failing."""
    paths = make_images(tmp_path, 2)
    responses = iter([
        FakeResponse(429, {"error": {"code": "RATE_LIMITED", "message": "slow"}}),
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
    ])
    slept = []
    monkeypatch.setattr("image2ppt.client.time.sleep", slept.append)
    client, _session = client_and_session(lambda *a, **k: next(responses))

    jobs = client.submit_all(paths)

    assert [job.job_id for job in jobs] == ["job_a"]
    assert slept == [5.0]  # the documented fallback, not zero


def test_submitted_jobs_also_survives_a_non_rate_limit_failure(tmp_path):
    """Any failure mid-pile strands paid-for jobs, not just a rate limit."""
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    responses = iter([
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
        FakeResponse(402, {"error": {"code": "INSUFFICIENT_CREDITS", "message": "no"}}),
    ])
    client, _session = client_and_session(lambda *a, **k: next(responses))

    with pytest.raises(InsufficientCreditsError) as exc:
        client.submit_all(paths)

    assert [job.job_id for job in exc.value.submitted_jobs] == ["job_a"]


def test_convert_all_hands_back_jobs_when_a_later_one_fails(tmp_path):
    """The first deck is on disk, the second job failed — but jobs 1..N are all
    still identified on the exception."""
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    out_dir = tmp_path / "decks"
    responses = iter([
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
        FakeResponse(201, {"jobId": "job_b", "status": "pending"}),
        FakeResponse(200, {"jobId": "job_a", "status": "completed"}),
        FakeResponse(200, content=b"DECK-A"),
        FakeResponse(200, {
            "jobId": "job_b", "status": "failed",
            "error": {"code": "CONVERSION_FAILED", "message": "boom"},
        }),
    ])
    client = make_client(lambda *a, **k: next(responses))

    with pytest.raises(JobFailedError) as exc:
        client.convert_all(paths, str(out_dir), poll_interval=0)

    assert [job.job_id for job in exc.value.submitted_jobs] == ["job_a", "job_b"]
    assert (out_dir / "part-01.pptx").read_bytes() == b"DECK-A"  # already delivered


# --------------------------------------------------------------------------- #
# per-file limit and destination checks — both must fail before spending money
# --------------------------------------------------------------------------- #
def test_submit_refuses_a_single_file_over_the_per_file_limit(tmp_path):
    """It fits the 45MB request cap, but the server rejects it every time."""
    big = sparse_file(tmp_path, "big.pdf", MAX_FILE_BYTES + 1)
    client, session = client_and_session(exploding_handler)

    with pytest.raises(InvalidFileError) as exc:
        client.submit([big])

    assert exc.value.code == "INVALID_FILE"
    assert "big.pdf" in exc.value.message
    assert len(session.calls) == 0


def test_submit_all_refuses_it_too_instead_of_planning_a_doomed_batch(tmp_path):
    big = sparse_file(tmp_path, "big.pdf", MAX_FILE_BYTES + 1)
    img = tmp_path / "a.png"
    img.write_bytes(png_bytes())
    client, session = client_and_session(exploding_handler)

    with pytest.raises(InvalidFileError):
        client.submit_all([str(img), big])

    assert len(session.calls) == 0  # the good file isn't submitted either


def test_convert_all_checks_the_destination_before_submitting_anything(tmp_path):
    """An unusable dest_dir must not cost credits: no job may exist afterwards."""
    paths = make_images(tmp_path, 2)
    not_a_dir = tmp_path / "decks"
    not_a_dir.write_text("I am a regular file")
    client, session = client_and_session(exploding_handler)

    with pytest.raises(OSError):
        client.convert_all(paths, str(not_a_dir))

    assert len(session.calls) == 0


# --------------------------------------------------------------------------- #
# PDF pages, and a destination that only *looks* usable
# --------------------------------------------------------------------------- #
def test_submit_counts_a_pdf_as_a_page_so_50_images_plus_one_is_refused(tmp_path):
    """50 images is exactly the limit; any PDF alongside makes it at least 51, so
    the server would reject it every time. Refuse locally, send nothing."""
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB)
    doc = tmp_path / "doc.pdf"
    doc.write_bytes(b"%PDF-1.4 tiny")
    paths.append(str(doc))
    client, session = client_and_session(exploding_handler)

    with pytest.raises(TooManySlidesError) as exc:
        client.submit(paths)

    assert "at least 51" in exc.value.message
    assert len(session.calls) == 0


def test_submit_still_accepts_49_images_plus_one_pdf(tmp_path):
    """The guard must not over-reach: 49 + 1 is exactly 50 at the lower bound."""
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB - 1)
    doc = tmp_path / "doc.pdf"
    doc.write_bytes(b"%PDF-1.4 tiny")
    paths.append(str(doc))
    client, session = client_and_session(
        lambda *a, **k: FakeResponse(201, {"jobId": "j", "status": "pending"})
    )

    client.submit(paths)

    assert len(posted_filenames(session)) == 1


def test_convert_all_refuses_a_dest_dir_that_exists_but_cannot_be_written(tmp_path):
    """The bug this catches: os.makedirs(exist_ok=True) SUCCEEDS on a read-only
    directory, so creating the directory early proved nothing — the submissions
    still went out and only writing the first deck failed, after the credits were
    spent. Only actually writing a file answers the question.
    """
    paths = make_images(tmp_path, 2)
    read_only = tmp_path / "decks"
    read_only.mkdir()
    os.chmod(read_only, 0o555)
    client, session = client_and_session(exploding_handler)
    try:
        assert os.path.isdir(read_only)  # it exists, so makedirs alone is happy

        with pytest.raises(OSError) as exc:
            client.convert_all(paths, str(read_only))

        assert "cannot write" in str(exc.value)
        assert len(session.calls) == 0  # nothing was submitted, nothing was charged
    finally:
        os.chmod(read_only, 0o755)  # let tmp_path cleanup remove it


def test_convert_all_leaves_no_probe_file_behind(tmp_path):
    """The writability probe must not litter the user's output directory."""
    paths = make_images(tmp_path, 1)
    out_dir = tmp_path / "decks"
    responses = iter([
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
        FakeResponse(200, {"jobId": "job_a", "status": "completed"}),
        FakeResponse(200, content=b"DECK-A"),
    ])

    make_client(lambda *a, **k: next(responses)).convert_all(
        paths, str(out_dir), poll_interval=0
    )

    assert sorted(p.name for p in out_dir.iterdir()) == ["part-01.pptx"]


# --------------------------------------------------------------------------- #
# Retry-After sanitising
#
# The retry loops sleep for as long as the server asks. Taken literally, three
# legal-looking header values turn that into a tight loop that re-sends the same
# multipart body — tens of megabytes of files — as fast as the link allows, for as
# long as the waiting budget lasts. These pin the floor that stops it.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "header, expected",
    [
        ("0", 1.0),  # legal ("retry now"), but literally zero is a flood
        ("0.25", 1.0),  # sub-second is the same problem, just slower
        ("12", 12.0),  # a real wait is passed through untouched
        ("-1", None),  # nonsense from a proxy; also made time.sleep raise
        ("nan", None),
        ("inf", None),
        ("Wed, 21 Oct 2026 07:28:00 GMT", None),  # HTTP-date form: not seconds
        ("", None),
        (None, None),
        # Spellings a language's own number parser would happily take. Accepting
        # "whatever float()/Number() allows" makes the two SDKs disagree about the
        # same header: float takes "1e3", JavaScript's Number takes "0x10".
        ("0x10", None),
        ("1e3", None),
        ("+5", None),
        (".5", None),
        ("5s", None),
        ("  12  ", 12.0),  # space/tab around a field value is the transport's
        ("\t12\t", 12.0),
        # Python's \d matches every Unicode decimal digit and JavaScript's matches
        # only ASCII. Left to \d, a full-width 5 would be five seconds here and
        # unparseable in the Node client — the same two-client disagreement this
        # parsing exists to remove.
        ("５", None),
        ("١٢", None),  # Arabic-Indic digits: also Unicode decimals
        ("\u00a05", None),  # non-breaking space is not HTTP whitespace
    ],
)
def test_retry_after_is_sanitised(header, expected):
    assert Image2PPTClient._parse_retry_after(header) == expected


def test_submit_all_never_busy_loops_on_retry_after_zero(tmp_path, monkeypatch):
    """A 429 with ``Retry-After: 0`` must still wait, not re-upload immediately."""
    paths = make_images(tmp_path, 2)
    responses = iter([
        FakeResponse(
            429,
            {"error": {"code": "RATE_LIMITED", "message": "slow"}},
            headers={"Retry-After": "0"},
        ),
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
    ])
    slept = []
    monkeypatch.setattr("image2ppt.client.time.sleep", slept.append)
    client, _session = client_and_session(lambda *a, **k: next(responses))

    jobs = client.submit_all(paths)

    assert [job.job_id for job in jobs] == ["job_a"]
    assert slept == [1.0]  # not 0: the retry is a retry, not a flood


def test_submit_all_treats_a_negative_retry_after_as_missing(tmp_path, monkeypatch):
    """A negative header used to reach ``time.sleep`` and raise ValueError."""
    paths = make_images(tmp_path, 2)
    responses = iter([
        FakeResponse(
            429,
            {"error": {"code": "RATE_LIMITED", "message": "slow"}},
            headers={"Retry-After": "-1"},
        ),
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
    ])
    slept = []
    monkeypatch.setattr("image2ppt.client.time.sleep", slept.append)
    client, _session = client_and_session(lambda *a, **k: next(responses))

    jobs = client.submit_all(paths)

    assert [job.job_id for job in jobs] == ["job_a"]
    assert slept == [5.0]  # the documented fallback, not a crash


# --------------------------------------------------------------------------- #
# Destination write probe
# --------------------------------------------------------------------------- #
def test_write_probe_does_not_touch_an_existing_file(tmp_path):
    """The probe must never open a path it did not create.

    A predictable probe name opened for writing truncates whatever is already
    there — including a symlink someone left in a shared output directory.
    """
    from image2ppt.client import _ensure_writable_dir

    dest = tmp_path / "decks"
    dest.mkdir()
    victim = tmp_path / "important.txt"
    victim.write_text("do not truncate me")
    # A symlink named the way a predictable probe would be named.
    (dest / f".image2ppt-write-test-{os.getpid()}").symlink_to(victim)

    _ensure_writable_dir(str(dest))

    assert victim.read_text() == "do not truncate me"


def test_write_probe_leaves_nothing_behind(tmp_path):
    dest = tmp_path / "decks"
    from image2ppt.client import _ensure_writable_dir

    _ensure_writable_dir(str(dest))

    assert list(dest.iterdir()) == []


# --------------------------------------------------------------------------- #
# Unsupported file types
#
# The accepted extensions are known locally, so uploading a .txt just to be told
# INVALID_FILE is a round trip that never had to happen — and in submit_all the
# batches ahead of it are already jobs with credits reserved by the time the server
# answers.
# --------------------------------------------------------------------------- #
def test_submit_refuses_an_unsupported_extension_without_sending_anything(tmp_path):
    doc = tmp_path / "notes.txt"
    doc.write_bytes(b"hello")
    client, session = client_and_session(exploding_handler)

    with pytest.raises(InvalidFileError) as exc:
        client.submit([str(doc)])

    assert exc.value.code == "INVALID_FILE"
    assert "notes.txt" in exc.value.message
    assert len(session.calls) == 0


def test_submit_all_refuses_before_paying_for_the_batches_ahead(tmp_path):
    """The unsupported file is last; the batches before it must not be submitted."""
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)
    doc = tmp_path / "notes.docx"
    doc.write_bytes(b"hello")
    client, session = client_and_session(exploding_handler)

    with pytest.raises(InvalidFileError) as exc:
        client.submit_all([*paths, str(doc)])

    assert exc.value.code == "INVALID_FILE"
    assert len(session.calls) == 0  # nothing created, nothing charged


# --------------------------------------------------------------------------- #
# Download is all-or-nothing
# --------------------------------------------------------------------------- #
class ExplodingBody(FakeResponse):
    """A 200 whose body dies partway through, like a dropped connection."""

    def iter_content(self, chunk_size=65536):
        yield b"PK\x03\x04 first half"
        raise requests.ConnectionError("connection reset mid-download")


def test_download_leaves_no_truncated_file_behind(tmp_path):
    dest = tmp_path / "deck.pptx"
    client = make_client(lambda *a, **k: ExplodingBody(200))

    with pytest.raises(requests.ConnectionError):
        client.download("job_a", str(dest))

    assert not dest.exists()  # a half deck would open in a listing and nowhere else
    assert list(tmp_path.iterdir()) == []  # and no leftover partial either


def test_a_failed_download_does_not_destroy_the_deck_already_there(tmp_path):
    """Writing straight to the destination would truncate it on the first chunk.

    ``convert_all`` reuses fixed names (``part-01.pptx``, ...), so a re-run whose
    download dies partway would replace a good deck from the previous run with a
    broken one — or with nothing.
    """
    dest = tmp_path / "deck.pptx"
    dest.write_bytes(b"PREVIOUS-GOOD-DECK")
    client = make_client(lambda *a, **k: ExplodingBody(200))

    with pytest.raises(requests.ConnectionError):
        client.download("job_a", str(dest))

    assert dest.read_bytes() == b"PREVIOUS-GOOD-DECK"
    assert [f.name for f in tmp_path.iterdir()] == ["deck.pptx"]


def test_download_writes_the_whole_deck_on_success(tmp_path):
    dest = tmp_path / "deck.pptx"
    client = make_client(lambda *a, **k: FakeResponse(200, content=b"DECK-BYTES"))

    assert client.download("job_a", str(dest)) == str(dest)
    assert dest.read_bytes() == b"DECK-BYTES"
    assert [f.name for f in tmp_path.iterdir()] == ["deck.pptx"]


# --------------------------------------------------------------------------- #
# Client identification
#
# Without a User-Agent the service cannot tell which SDK version made a request, so
# it can never warn anyone that theirs is about to stop working.
# --------------------------------------------------------------------------- #
def test_requests_identify_the_sdk_and_its_version():
    import image2ppt

    session = FakeSession(lambda *a, **k: FakeResponse(200, {"email": "e", "credits": 1}))
    Image2PPTClient("i2p_live_test", session=session).account()

    assert session.headers["User-Agent"] == f"image2ppt-python/{image2ppt.__version__}"


# --------------------------------------------------------------------------- #
# Error-code mapping for the codes the contract lists
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "code, expected",
    [
        ("NO_FILES", NoFilesError),
        ("INVALID_ASPECT_RATIO", InvalidAspectRatioError),
        ("PAGE_RATE_EXCEEDED", PageRateExceededError),
    ],
)
def test_documented_400_codes_get_their_own_type(tmp_path, code, expected):
    """These used to land on the base class, so `except InvalidFileError` missed
    them and callers had to compare strings."""
    paths = make_images(tmp_path, 1)
    client = make_client(
        lambda *a, **k: FakeResponse(400, {"error": {"code": code, "message": "no"}})
    )

    with pytest.raises(expected) as exc:
        client.submit(paths)

    assert exc.value.code == code
    assert isinstance(exc.value, Image2PPTError)


# --------------------------------------------------------------------------- #
# The rate-limit waiting budget
#
# ``rate_limit_max_wait`` promises time spent *waiting*. A wall-clock deadline set
# at the start of the call would be spent by the uploads themselves, so on a slow
# link a large pile could exhaust it before the first 429 ever arrived — turning the
# option into "do not wait at all", with the cutoff decided by link speed.
# --------------------------------------------------------------------------- #
def test_upload_time_does_not_consume_the_rate_limit_budget(tmp_path, monkeypatch):
    paths = make_images(tmp_path, MAX_PAGES_PER_JOB + 1)  # two batches
    responses = iter([
        FakeResponse(201, {"jobId": "job_a", "status": "pending"}),
        rate_limited_response(),  # second batch bounces
        FakeResponse(201, {"jobId": "job_b", "status": "pending"}),
    ])
    slept = []
    monkeypatch.setattr("image2ppt.client.time.sleep", slept.append)
    # The clock races far past the whole budget while the first batch uploads. Only
    # waiting may take from the budget, so this must not change the outcome.
    clock = iter([0.0, 10_000.0, 20_000.0, 30_000.0, 40_000.0])
    monkeypatch.setattr("image2ppt.client.time.monotonic", lambda: next(clock, 40_000.0))
    client, _session = client_and_session(
        lambda *a, **k: next(responses), rate_limit_max_wait=10
    )

    jobs = client.submit_all(paths)

    assert [job.job_id for job in jobs] == ["job_a", "job_b"]
    assert slept == [1.0]  # it waited, rather than giving up on a spent wall clock


def test_the_budget_is_spent_by_waiting_and_then_gives_up(tmp_path, monkeypatch):
    """Two waits of 4s fit in a 10s budget; the third does not."""
    paths = make_images(tmp_path, 2)
    responses = iter([
        rate_limited_response("4"),
        rate_limited_response("4"),
        rate_limited_response("4"),
    ])
    slept = []
    monkeypatch.setattr("image2ppt.client.time.sleep", slept.append)

    def handler(*_args, **_kwargs):
        # A budget that never depletes would retry forever. Fail loudly instead of
        # hanging the suite.
        try:
            return next(responses)
        except StopIteration:
            raise AssertionError("retried past the waiting budget") from None

    client, _session = client_and_session(handler, rate_limit_max_wait=10)

    with pytest.raises(RateLimitedError):
        client.submit_all(paths)

    assert slept == [4.0, 4.0]  # 8s spent, the third 4s would not fit


def test_a_batch_is_not_retried_forever_on_a_cheap_retry_after(tmp_path, monkeypatch):
    """The waiting budget cannot see the uploads, and every retry re-sends them.

    A server answering ``Retry-After: 1`` costs a second of budget per round, so a
    30-minute budget alone would buy ~1800 rounds — 1800 re-uploads of the same
    files. The attempt cap is what bounds the work rather than the waiting.
    """
    from image2ppt.client import _MAX_BATCH_ATTEMPTS

    paths = make_images(tmp_path, 2)
    slept = []
    monkeypatch.setattr("image2ppt.client.time.sleep", slept.append)
    client, session = client_and_session(
        lambda *a, **k: rate_limited_response("1"), rate_limit_max_wait=1800
    )

    with pytest.raises(RateLimitedError):
        client.submit_all(paths)

    assert len(session.calls) == _MAX_BATCH_ATTEMPTS  # not ~1800
    assert len(slept) == _MAX_BATCH_ATTEMPTS
