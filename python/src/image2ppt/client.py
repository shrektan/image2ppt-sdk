"""The image2ppt API client."""

from __future__ import annotations

import mimetypes
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

import requests
from PIL import Image, UnidentifiedImageError

from ._compress import IMAGE_MIMES, compress_image_for_upload
from ._limits import UploadItem, check_file_size, check_submission, plan_batches
from .errors import (
    Image2PPTError,
    Image2PPTTimeoutError,
    InvalidFileError,
    JobFailedError,
    RateLimitedError,
    exception_for,
)
from .models import Job

DEFAULT_BASE_URL = "https://image2ppt.com"

#: Wait between rate-limited retries when the server sends no ``Retry-After``.
_RATE_LIMIT_FALLBACK_WAIT = 5.0


def _attach_submitted_jobs(exc: BaseException, jobs: Sequence[Job]) -> None:
    """Record the jobs created so far on an exception escaping a batch call.

    Every ``Image2PPTError`` declares ``submitted_jobs``; this also reaches the
    rarer non-SDK escape (an exhausted connection error), so the caller never has
    to know which kind they caught to find out what they already paid for.
    """
    try:
        exc.submitted_jobs = list(jobs)  # type: ignore[attr-defined]
    except AttributeError:
        pass  # exotic exception type with no __dict__: nothing we can do


@dataclass(frozen=True)
class _PreparedFile:
    """One file resolved to exactly what will go into the multipart body.

    Built before any connection is opened, so the request size is known up front.

    ``payload`` holds the bytes for an image (already compressed). For a PDF it is
    ``None`` and the file is streamed from ``path`` instead, so a large PDF never
    sits in memory — ``size`` is then its size on disk.
    """

    filename: str
    mime: str
    payload: Optional[bytes]
    path: str
    size: int
    is_image: bool


class Image2PPTClient:
    """Client for the image2ppt API.

    Args:
        api_key: Your API key (looks like ``i2p_live_...``), created on the
            Developer / API page.
        base_url: Service base URL, defaults to ``https://image2ppt.com``.
        timeout: Per-HTTP-request timeout in seconds (not the whole-job wait).
        session: Optional ``requests.Session`` to inject (for testing or pooling).
        rate_limit_max_wait: Total seconds ``submit_all`` / ``convert_all`` may
            spend waiting out rate limits across the whole call (default 1800 =
            30 min). Submitting a large pile *will* hit the per-minute page quota,
            so waiting is the normal path, not an error.
    """

    #: Supported input extensions -> MIME type (for labeling multipart uploads).
    _MIME_BY_EXT = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
    }

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 60.0,
        session: Optional[requests.Session] = None,
        rate_limit_max_wait: float = 1800.0,
    ) -> None:
        if not api_key:
            raise ValueError("api_key must not be empty")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.rate_limit_max_wait = max(0.0, rate_limit_max_wait)
        self._session = session or requests.Session()
        self._session.headers.update({"Authorization": f"Bearer {api_key}"})

    # ----- public methods ---------------------------------------------- #
    def submit(
        self,
        paths: Sequence[str],
        *,
        locale: Optional[str] = None,
        aspect_ratio: Optional[str] = None,
    ) -> Job:
        """Submit a batch of files and create a conversion job.

        Checked locally before anything is uploaded: the files must add up to at
        most 45MB and at most 50 pages. Over either limit this raises without
        opening a connection — going over the size cap on the wire does not come
        back as a clean error, it comes back as a dead connection.

        **A failed submission is never retried automatically.** A connection error
        does not tell you whether the request body made it: the job may not exist,
        or it may exist with credits already reserved and only the response lost.
        Retrying the second case charges twice, and without an idempotency key
        there is no way to tell them apart — so the error is raised as-is. Check
        ``account()`` or your job list before resending.

        Args:
            paths: Local file paths (one or more). Supports png/jpeg/webp/gif/pdf,
                each file <= 35MB, and <= 45MB of file content per request. An
                image is 1 page, a PDF is its page count; the total must be
                <= 50 pages. For more files than one request can hold, use
                ``submit_all`` / ``convert_all``.
            locale: ``zh-CN`` (default) or ``en``.
            aspect_ratio: ``auto`` (default) / ``16:9`` / ``4:3``.

        Returns:
            A ``Job`` with ``status`` ``pending``, plus ``slide_count`` and
            ``credits_reserved`` (credits locked at submit time).

        Raises:
            AuthenticationError, InvalidFileError (including the local per-file
            and ``PAYLOAD_TOO_LARGE`` pre-flight failures), TooManySlidesError,
            InsufficientCreditsError, RateLimitedError.
            ``requests.RequestException`` propagates unchanged for a transport
            failure — see above on why it is not retried.
        """
        paths = list(paths)
        if not paths:
            raise ValueError("at least one file is required")

        data: Dict[str, str] = {}
        if locale is not None:
            data["locale"] = locale
        if aspect_ratio is not None:
            data["aspectRatio"] = aspect_ratio

        prepared = [self._prepare_file(path) for path in paths]
        # Pre-flight, before a single byte goes out: an oversized request is not
        # answered with an error, it is cut off — so it must never be sent.
        for item in prepared:
            check_file_size(item.path, item.size)
        check_submission(
            total_bytes=sum(item.size for item in prepared),
            image_pages=sum(1 for item in prepared if item.is_image),
        )
        resp = self._post_files(prepared, data)
        return Job.from_dict(self._parse_json(resp))

    def submit_all(
        self,
        paths: Sequence[str],
        *,
        locale: Optional[str] = None,
        aspect_ratio: Optional[str] = None,
    ) -> List[Job]:
        """Split files into submittable batches and create **one job per batch**.

        For a pile of files too big or too numerous for a single request. Batching
        rules live in ``image2ppt._limits.plan_batches``: at most 40MB of file
        content and at most 50 images per batch, and every PDF in a batch of its
        own (the SDK does not parse PDFs, so only the server knows their page
        count). Input order is preserved.

        **Each returned job produces its own PPTX.** There is no server-side merge
        — N batches means N decks. If you need exactly one deck, keep the
        submission inside one request's limits and use ``convert``.

        **Rate limits are waited out, not raised.** A pile big enough to need
        batching is a pile big enough to hit the account's per-minute page quota
        (and its cap on concurrently active jobs). Both arrive as a 429 with a
        ``Retry-After``, and both are handled the same way: sleep that long, then
        try the same batch again. Waiting is the normal path here. Total waiting is
        capped by the client's ``rate_limit_max_wait``.

        **Connection errors are not retried** — see ``submit``. Only a 429 is,
        because only a 429 proves the server did not take the submission.

        **If it does give up, the jobs already created are handed back on the
        exception**, in ``exc.submitted_jobs``. Those jobs are running on the
        server with credits already reserved — they are not lost and not refunded.
        Wait on them or fetch them later; do not resubmit those files.

        Args:
            paths: Local file paths.
            locale: ``zh-CN`` (default) or ``en``.
            aspect_ratio: ``auto`` (default) / ``16:9`` / ``4:3``.

        Returns:
            One pending ``Job`` per batch, in batch order.

        Raises:
            InvalidFileError: A single file is over the per-request limit on its
                own, so no batching can carry it. Plus the same errors as
                ``submit`` for each batch.
            RateLimitedError: Still rate limited after ``rate_limit_max_wait``
                seconds of waiting.
        """
        paths = list(paths)
        if not paths:
            raise ValueError("at least one file is required")

        batches = plan_batches(self._upload_items(paths))
        deadline = time.monotonic() + self.rate_limit_max_wait
        jobs: List[Job] = []
        for batch in batches:
            try:
                jobs.append(
                    self._submit_batch(
                        [item.path for item in batch],
                        locale=locale,
                        aspect_ratio=aspect_ratio,
                        deadline=deadline,
                    )
                )
            except Exception as exc:
                # Whatever went wrong, the earlier batches are already jobs on the
                # server with credits reserved. Losing the ids would mean the caller
                # paid for work they can never collect.
                _attach_submitted_jobs(exc, jobs)
                raise
        return jobs

    def get_job(self, job_id: str) -> Job:
        """Fetch the current job state as a ``Job`` snapshot. Raises JobNotFoundError."""
        resp = self._session.get(
            f"{self.base_url}/api/v1/jobs/{job_id}",
            timeout=self.timeout,
        )
        return Job.from_dict(self._parse_json(resp))

    def wait(
        self,
        job_id: str,
        *,
        poll_interval: float = 5.0,
        timeout: float = 1800.0,
    ) -> Job:
        """Poll until the job reaches a terminal state; return the completed ``Job``.

        The poll interval starts at ``poll_interval`` and backs off to 15s max. On a
        429 it waits the ``Retry-After`` seconds before continuing. A failed job
        raises JobFailedError; exceeding ``timeout`` raises Image2PPTTimeoutError
        (the job itself may still be running).

        Args:
            job_id: The job id.
            poll_interval: Initial poll interval in seconds (default 5).
            timeout: Overall wait cap in seconds (default 1800 = 30 min).
        """
        deadline = time.monotonic() + timeout
        interval = poll_interval
        while True:
            try:
                job = self.get_job(job_id)
            except RateLimitedError as exc:
                sleep_for = exc.retry_after if exc.retry_after is not None else interval
                self._sleep_until(deadline, sleep_for, job_id)
                continue
            except (Image2PPTError, requests.RequestException) as exc:
                # A single poll hit a transient server (5xx) or network error. The job
                # itself may still be running, so back off and retry until the deadline
                # instead of aborting the whole wait/convert. Client errors (4xx: job
                # gone, bad key) are not transient — re-raise them immediately.
                if isinstance(exc, Image2PPTError) and (
                    exc.status_code is None or exc.status_code < 500
                ):
                    raise
                self._sleep_until(deadline, interval, job_id)
                interval = min(interval * 1.5, 15.0)
                continue

            if job.is_completed:
                return job
            if job.is_failed:
                err = job.error or {}
                raise JobFailedError(
                    err.get("message") or "conversion failed",
                    code=err.get("code"),
                    job=job,
                )

            self._sleep_until(deadline, interval, job_id)
            interval = min(interval * 1.5, 15.0)

    def download(self, job_id: str, dest_path: str) -> str:
        """Stream a completed job's PPTX to ``dest_path``; return that path.

        Raises NotReadyError (409) if the job isn't done, JobNotFoundError (404) if
        it doesn't exist, OutputExpiredError (410) if the deliverable was reaped.
        """
        resp = self._session.get(
            f"{self.base_url}/api/v1/jobs/{job_id}/download",
            stream=True,
            timeout=self.timeout,
        )
        try:
            if not resp.ok:
                self._raise_for_error(resp)
            with open(dest_path, "wb") as out:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        out.write(chunk)
        finally:
            resp.close()
        return dest_path

    def convert(
        self,
        paths: Sequence[str],
        dest_path: str,
        *,
        locale: Optional[str] = None,
        aspect_ratio: Optional[str] = None,
        poll_interval: float = 5.0,
        timeout: float = 1800.0,
    ) -> Job:
        """One-shot: submit -> wait for completion -> download to ``dest_path``.

        Arguments mirror ``submit`` and ``wait``. For the synchronous
        "give me a batch of images, hand me back a PPTX" case.

        One job, one PPTX — the files must fit in a single submission (45MB,
        50 pages). For more than that, ``convert_all`` splits the pile and writes
        one PPTX per batch.
        """
        job = self.submit(paths, locale=locale, aspect_ratio=aspect_ratio)
        completed = self.wait(job.job_id, poll_interval=poll_interval, timeout=timeout)
        self.download(completed.job_id, dest_path)
        return completed

    def convert_all(
        self,
        paths: Sequence[str],
        dest_dir: str,
        *,
        locale: Optional[str] = None,
        aspect_ratio: Optional[str] = None,
        poll_interval: float = 5.0,
        timeout: float = 1800.0,
    ) -> List[str]:
        """Batch version of ``convert``: submit everything, wait, download each deck.

        Files are split with ``submit_all``, every batch is submitted first (so the
        server works on them in parallel), then each job is waited on and
        downloaded in order.

        **This writes one PPTX per batch, not one merged deck.** Output files are
        named ``part-01.pptx``, ``part-02.pptx``, ... inside ``dest_dir`` — stable
        for the same input, and never overwriting each other. Existing files with
        those names are overwritten. ``convert`` is unchanged: one job, one PPTX.

        Args:
            paths: Local file paths.
            dest_dir: Directory for the PPTX files; created **before anything is
                submitted**, so an unusable destination costs nothing.
            locale: ``zh-CN`` (default) or ``en``.
            aspect_ratio: ``auto`` (default) / ``16:9`` / ``4:3``.
            poll_interval: Initial poll interval in seconds.
            timeout: Wait cap **per job** in seconds, not for the whole pile.

        Returns:
            The written file paths, in batch order.

        Rate limits during submission are waited out — see ``submit_all``.

        Raises:
            JobFailedError, Image2PPTTimeoutError, RateLimitedError: A job failed,
                ran past its wait cap, or the pile stayed rate limited too long.
                Earlier batches that already downloaded stay on disk, and every job
                created so far is on the exception as ``exc.submitted_jobs`` —
                those are still running with credits reserved, so wait on them
                rather than resubmitting.
        """
        # Before anything is submitted: if the destination is unusable, fail now
        # rather than after N jobs exist with credits reserved and nowhere to put
        # their output. This is the one step that can fail for free.
        os.makedirs(dest_dir, exist_ok=True)

        jobs = self.submit_all(paths, locale=locale, aspect_ratio=aspect_ratio)

        written: List[str] = []
        try:
            for index, job in enumerate(jobs, start=1):
                completed = self.wait(job.job_id, poll_interval=poll_interval, timeout=timeout)
                dest_path = os.path.join(dest_dir, f"part-{index:02d}.pptx")
                self.download(completed.job_id, dest_path)
                written.append(dest_path)
        except Exception as exc:
            # Same contract as submit_all: the jobs are already paid for, so the
            # caller gets their ids back instead of having to guess.
            _attach_submitted_jobs(exc, jobs)
            raise
        return written

    def account(self) -> Dict[str, Any]:
        """Return account info: ``{"email": ..., "credits": available_credits}``."""
        resp = self._session.get(
            f"{self.base_url}/api/v1/account",
            timeout=self.timeout,
        )
        return self._parse_json(resp)

    # ----- internal helpers -------------------------------------------- #
    def _submit_batch(
        self,
        paths: Sequence[str],
        *,
        locale: Optional[str],
        aspect_ratio: Optional[str],
        deadline: float,
    ) -> Job:
        """Submit one batch, waiting out rate limits until ``deadline``.

        Retrying a 429 is not the same gamble as retrying a broken upload: a 429 is
        the server saying it did *not* take the submission. Nothing was created and
        nothing was charged, so trying the same batch again is free.

        Both flavors of 429 (per-minute page quota, concurrent-job cap) carry a
        ``Retry-After`` and are handled identically. When the header is missing we
        fall back to a fixed wait.
        """
        while True:
            try:
                return self.submit(paths, locale=locale, aspect_ratio=aspect_ratio)
            except RateLimitedError as exc:
                delay = (
                    exc.retry_after
                    if exc.retry_after is not None
                    else _RATE_LIMIT_FALLBACK_WAIT
                )
                remaining = deadline - time.monotonic()
                if remaining <= 0 or delay > remaining:
                    raise
                time.sleep(delay)

    def _prepare_file(self, path: str) -> _PreparedFile:
        """Resolve one path to its multipart part and its exact size on the wire."""
        filename = os.path.basename(path)
        mime = self._guess_mime(filename)
        if mime not in IMAGE_MIMES:
            # PDFs and other non-images: uploaded as-is and streamed from disk, so
            # the wire size is the size on disk.
            return _PreparedFile(
                filename=filename,
                mime=mime,
                payload=None,
                path=path,
                size=os.path.getsize(path),
                is_image=False,
            )

        # Images: pre-compress to the server spec so its pass is a passthrough.
        with open(path, "rb") as fh:
            raw = fh.read()
        try:
            payload, out_mime = compress_image_for_upload(raw, mime)
        except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as exc:
            # Corrupt/truncated image, or one over Pillow's decompression-bomb
            # threshold. Surface it as an SDK error (like a server INVALID_FILE)
            # so callers catching Image2PPTError don't get a raw Pillow type.
            raise InvalidFileError(
                f"could not read image {filename!r}: {exc}",
                code="INVALID_FILE",
            ) from exc
        if out_mime == "image/jpeg" and not filename.lower().endswith((".jpg", ".jpeg")):
            # Compressed to JPEG: align the extension so name matches content.
            filename = os.path.splitext(filename)[0] + ".jpg"
        return _PreparedFile(
            filename=filename,
            mime=out_mime,
            payload=payload,
            path=path,
            size=len(payload),
            is_image=True,
        )

    def _upload_items(self, paths: Sequence[str]) -> List[UploadItem]:
        """Measure files for batch planning, using the size they will occupy on the wire."""
        return [
            UploadItem(path=item.path, size=item.size, is_pdf=not item.is_image)
            for item in (self._prepare_file(path) for path in paths)
        ]

    def _post_files(
        self, prepared: Sequence[_PreparedFile], data: Dict[str, str]
    ) -> requests.Response:
        """POST the multipart submission exactly once.

        **A failed submission is never retried automatically**, and that is
        deliberate. When ``requests`` raises ``ConnectionError`` the only thing it
        proves is that this exchange broke; it does *not* prove the request body
        was incomplete. The server may have received the whole body, created the
        job and reserved the credits, and then lost the connection on the way back
        with the response. Those two cases are indistinguishable from here, and
        retrying the second one submits the same files twice and charges twice.

        Telling them apart needs an idempotency key the API does not offer, so the
        error goes straight to the caller: check ``account()`` or your job list to
        see whether the job exists, then decide whether to resend.

        (Rate limiting is a different animal — a 429 is the server explicitly
        saying it did *not* take the submission, so ``submit_all`` does retry that.)
        """
        opened = []
        multipart = []
        try:
            for item in prepared:
                if item.payload is not None:
                    multipart.append(("files", (item.filename, item.payload, item.mime)))
                else:
                    handle = open(item.path, "rb")
                    opened.append(handle)
                    multipart.append(("files", (item.filename, handle, item.mime)))
            return self._session.post(
                f"{self.base_url}/api/v1/jobs",
                files=multipart,
                data=data,
                timeout=self.timeout,
            )
        finally:
            for handle in opened:
                handle.close()

    def _guess_mime(self, filename: str) -> str:
        ext = os.path.splitext(filename)[1].lower()
        if ext in self._MIME_BY_EXT:
            return self._MIME_BY_EXT[ext]
        guessed, _ = mimetypes.guess_type(filename)
        return guessed or "application/octet-stream"

    def _sleep_until(self, deadline: float, seconds: float, job_id: str) -> None:
        """Sleep ``seconds``, but never past ``deadline``; raise TimeoutError if past."""
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Image2PPTTimeoutError(f"timed out waiting for job {job_id}", job_id=job_id)
        time.sleep(min(seconds, remaining))

    def _parse_json(self, resp: requests.Response) -> Dict[str, Any]:
        """Return the JSON body on 2xx; otherwise raise the mapped exception."""
        if not resp.ok:
            self._raise_for_error(resp)
        return resp.json()

    def _raise_for_error(self, resp: requests.Response) -> None:
        """Parse the ``{"error": {code, message}}`` envelope and raise the mapped error."""
        code: Optional[str] = None
        message: Optional[str] = None
        try:
            body = resp.json()
            err = body.get("error") if isinstance(body, dict) else None
            if isinstance(err, dict):
                code = err.get("code")
                message = err.get("message")
        except ValueError:
            pass  # non-JSON error body (e.g. a gateway HTML page): fall back to status text
        message = message or f"request failed (HTTP {resp.status_code})"

        raise exception_for(
            status_code=resp.status_code,
            code=code,
            message=message,
            retry_after=self._parse_retry_after(resp.headers.get("Retry-After")),
        )

    @staticmethod
    def _parse_retry_after(value: Optional[str]) -> Optional[float]:
        """Parse the Retry-After header as seconds (contract: integer seconds)."""
        if not value:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
