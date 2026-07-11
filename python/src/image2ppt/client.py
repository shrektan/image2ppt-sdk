"""The image2ppt API client."""

from __future__ import annotations

import mimetypes
import os
import time
from typing import Any, Dict, Optional, Sequence

import requests

from ._compress import IMAGE_MIMES, compress_image_for_upload
from .errors import (
    Image2PPTError,
    Image2PPTTimeoutError,
    JobFailedError,
    RateLimitedError,
    exception_for,
)
from .models import Job

DEFAULT_BASE_URL = "https://image2ppt.com"


class Image2PPTClient:
    """Client for the image2ppt API.

    Args:
        api_key: Your API key (looks like ``i2p_live_...``), created on the
            Developer / API page.
        base_url: Service base URL, defaults to ``https://image2ppt.com``.
        timeout: Per-HTTP-request timeout in seconds (not the whole-job wait).
        session: Optional ``requests.Session`` to inject (for testing or pooling).
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
    ) -> None:
        if not api_key:
            raise ValueError("api_key must not be empty")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
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

        Args:
            paths: Local file paths (one or more). Supports png/jpeg/webp/gif/pdf,
                each file <= 35MB. An image is 1 page, a PDF is its page count;
                the total must be <= 50 pages.
            locale: ``zh-CN`` (default) or ``en``.
            aspect_ratio: ``auto`` (default) / ``16:9`` / ``4:3``.

        Returns:
            A ``Job`` with ``status`` ``pending``, plus ``slide_count`` and
            ``credits_reserved`` (credits locked at submit time).

        Raises:
            AuthenticationError, InvalidFileError, TooManySlidesError,
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

        opened = []
        multipart = []
        try:
            for path in paths:
                filename = os.path.basename(path)
                mime = self._guess_mime(filename)
                if mime in IMAGE_MIMES:
                    # Images: pre-compress to the server spec so its pass is a passthrough.
                    with open(path, "rb") as fh:
                        raw = fh.read()
                    payload, out_mime = compress_image_for_upload(raw, mime)
                    if out_mime == "image/jpeg" and not filename.lower().endswith(
                        (".jpg", ".jpeg")
                    ):
                        # Compressed to JPEG: align the extension so name matches content.
                        filename = os.path.splitext(filename)[0] + ".jpg"
                    multipart.append(("files", (filename, payload, out_mime)))
                else:
                    # PDFs and other non-images: upload as-is (streamed), render server-side.
                    handle = open(path, "rb")
                    opened.append(handle)
                    multipart.append(("files", (filename, handle, mime)))
            resp = self._session.post(
                f"{self.base_url}/api/v1/jobs",
                files=multipart,
                data=data,
                timeout=self.timeout,
            )
        finally:
            for handle in opened:
                handle.close()

        return Job.from_dict(self._parse_json(resp))

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
        """
        job = self.submit(paths, locale=locale, aspect_ratio=aspect_ratio)
        completed = self.wait(job.job_id, poll_interval=poll_interval, timeout=timeout)
        self.download(completed.job_id, dest_path)
        return completed

    def account(self) -> Dict[str, Any]:
        """Return account info: ``{"email": ..., "credits": available_credits}``."""
        resp = self._session.get(
            f"{self.base_url}/api/v1/account",
            timeout=self.timeout,
        )
        return self._parse_json(resp)

    # ----- internal helpers -------------------------------------------- #
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
