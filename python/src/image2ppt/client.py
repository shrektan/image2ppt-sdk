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
from ._limits import UploadItem, check_submission, plan_batches
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
        max_upload_retries: How many times to retry a submission whose connection
            broke mid-upload (default 2). See ``submit`` for why that is safe and
            why a read timeout is never retried.
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
        max_upload_retries: int = 2,
    ) -> None:
        if not api_key:
            raise ValueError("api_key must not be empty")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_upload_retries = max(0, max_upload_retries)
        #: Seconds before the first upload retry; doubles on each further attempt.
        #: Internal knob — tests set it to 0 to run without real sleeps.
        self._upload_retry_backoff = 1.0
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

        If the connection breaks *while uploading*, the submission is retried
        (see ``max_upload_retries``).

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
            AuthenticationError, InvalidFileError (including the local
            ``PAYLOAD_TOO_LARGE`` pre-flight failure), TooManySlidesError,
            InsufficientCreditsError, RateLimitedError.
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

        Batches are submitted back to back. A very large pile can trip the
        account's submission rate limit; that surfaces as ``RateLimitedError``
        with ``retry_after``, and any jobs already created stay created.

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
        """
        paths = list(paths)
        if not paths:
            raise ValueError("at least one file is required")

        batches = plan_batches(self._upload_items(paths))
        return [
            self.submit(
                [item.path for item in batch],
                locale=locale,
                aspect_ratio=aspect_ratio,
            )
            for batch in batches
        ]

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
            dest_dir: Directory for the PPTX files; created if missing.
            locale: ``zh-CN`` (default) or ``en``.
            aspect_ratio: ``auto`` (default) / ``16:9`` / ``4:3``.
            poll_interval: Initial poll interval in seconds.
            timeout: Wait cap **per job** in seconds, not for the whole pile.

        Returns:
            The written file paths, in batch order.

        Raises:
            JobFailedError, Image2PPTTimeoutError: A job failed or ran past its
                wait cap. Earlier batches that already downloaded stay on disk;
                later ones are not waited on. Their ids are in ``submit_all``'s
                return value if you want to drive the waiting yourself.
        """
        jobs = self.submit_all(paths, locale=locale, aspect_ratio=aspect_ratio)
        os.makedirs(dest_dir, exist_ok=True)

        written: List[str] = []
        for index, job in enumerate(jobs, start=1):
            completed = self.wait(job.job_id, poll_interval=poll_interval, timeout=timeout)
            dest_path = os.path.join(dest_dir, f"part-{index:02d}.pptx")
            self.download(completed.job_id, dest_path)
            written.append(dest_path)
        return written

    def account(self) -> Dict[str, Any]:
        """Return account info: ``{"email": ..., "credits": available_credits}``."""
        resp = self._session.get(
            f"{self.base_url}/api/v1/account",
            timeout=self.timeout,
        )
        return self._parse_json(resp)

    # ----- internal helpers -------------------------------------------- #
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
        """POST the multipart submission, retrying a connection that broke mid-upload.

        Only ``ConnectionError`` is retried, and never ``ReadTimeout``. The
        difference matters because a retry can cost money:

        - ``ConnectionError`` means the request body never arrived in full. The
          server cannot have parsed it, so it cannot have created a job or
          reserved credits. Retrying is free.
        - ``ReadTimeout`` means the body *was* sent and we simply gave up waiting
          for the response. The job may well exist, with credits already reserved.
          Retrying would submit the same files a second time and charge twice, so
          it is raised as-is — check ``account()`` or your job list before resending.
        """
        attempt = 0
        while True:
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
            except requests.exceptions.ConnectionError:
                if attempt >= self.max_upload_retries:
                    raise
                time.sleep(self._upload_retry_backoff * (2**attempt))
                attempt += 1
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
