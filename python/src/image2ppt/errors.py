"""Exception hierarchy for the image2ppt client.

Every error carries the HTTP ``status_code``, the server error ``code`` (from the
``{"error": {"code", "message"}}`` envelope), and a human-readable ``message``.
Branch on ``code``, not ``message`` — messages may be reworded.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class Image2PPTError(Exception):
    """Base class for all client errors."""

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        #: Jobs already created when this error was raised out of ``submit_all`` /
        #: ``convert_all``. They are **running on the server with credits already
        #: reserved** — they are not lost and not refunded by the failure. Wait on
        #: them (``wait``/``download``) or come back to them later. Empty for any
        #: error not raised out of a batch call.
        self.submitted_jobs: List[Any] = []

    def __str__(self) -> str:
        parts = []
        if self.status_code is not None:
            parts.append(f"HTTP {self.status_code}")
        if self.code:
            parts.append(self.code)
        prefix = " ".join(parts)
        return f"[{prefix}] {self.message}" if prefix else self.message


class AuthenticationError(Image2PPTError):
    """API key is missing, invalid, or the account is gone (401 / 403)."""


class InvalidFileError(Image2PPTError):
    """A file was rejected (400), or the request carried too much file content.

    Raised for an unsupported format, a single file over the 35MB per-file limit,
    or a request whose files add up to more than the 45MB per-request limit
    (413 ``PAYLOAD_TOO_LARGE``). The client raises the ``PAYLOAD_TOO_LARGE`` case
    locally, before uploading anything.
    """


class UploadAbortedError(Image2PPTError):
    """The upload was cut off before the body finished arriving (400 ``UPLOAD_ABORTED``).

    The server is telling you it did **not** take the submission — no job was created
    and no credits were reserved — so **resending the same files is safe**. That makes
    this different from a transport-level ``requests.ConnectionError``, which cannot
    rule out that the job was created and only the response was lost; the client never
    retries that one for you (see ``Client._post_files``).

    If it keeps happening, the submission is probably too large for the link. Send
    fewer files per request, or use ``submit_all`` / ``convert_all`` to split.
    """


class MalformedUploadError(Image2PPTError):
    """The body was not valid ``multipart/form-data`` (400 ``MALFORMED_UPLOAD``).

    A client-side framing problem: **retrying the identical payload will not help**.
    Using this SDK unmodified you should never see it; if you do, please report it.
    """


class TooManySlidesError(Image2PPTError):
    """The submission exceeds the 50-page-per-job limit (400 TOO_MANY_SLIDES)."""


class InsufficientCreditsError(Image2PPTError):
    """Not enough available credits to cover the submission (402)."""


class RateLimitedError(Image2PPTError):
    """Rate limited (429 RATE_LIMITED).

    ``retry_after`` is the server-suggested wait in seconds (from the
    ``Retry-After`` header); retry after that long.

    Both kinds of 429 land here — the per-minute page quota and the cap on
    concurrently active jobs — and both are handled the same way: wait, then try
    the same submission again. ``submit_all`` / ``convert_all`` do that for you;
    if one of them gives up, ``submitted_jobs`` holds the jobs already created.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(message, status_code=status_code, code=code)
        self.retry_after = retry_after


class JobNotFoundError(Image2PPTError):
    """The job id doesn't exist, or isn't owned by this key's account (404)."""


class NotReadyError(Image2PPTError):
    """The job hasn't finished yet, so the deliverable can't be downloaded (409)."""


class OutputExpiredError(Image2PPTError):
    """The job finished, but its PPTX passed the retention window and was reaped (410)."""


class JobFailedError(Image2PPTError):
    """The job ended in failure (raised by ``wait`` when it polls status=failed).

    ``job`` is the failure snapshot; ``code`` / ``message`` come from its ``error`` field.
    """

    def __init__(
        self,
        message: str,
        *,
        code: Optional[str] = None,
        job: Optional[Any] = None,
    ) -> None:
        super().__init__(message, code=code)
        self.job = job


class Image2PPTTimeoutError(Image2PPTError):
    """``wait`` exceeded its ``timeout`` before the job reached a terminal state.

    This does not mean the job failed — it may still be running. Re-``wait`` on the
    ``job_id`` later. (The prefix avoids shadowing the builtin ``TimeoutError``.)
    """

    def __init__(self, message: str, *, job_id: Optional[str] = None) -> None:
        super().__init__(message)
        self.job_id = job_id


# Server error code -> exception class. Unlisted codes fall back to the status-code
# map, then to the base class.
_CODE_TO_EXC: Dict[str, type] = {
    "INVALID_API_KEY": AuthenticationError,
    "API_KEY_REQUIRED": AuthenticationError,
    "ACCOUNT_DELETED": AuthenticationError,
    "INVALID_FILE": InvalidFileError,
    "INVALID_PDF": InvalidFileError,
    "PAYLOAD_TOO_LARGE": InvalidFileError,
    "UPLOAD_ABORTED": UploadAbortedError,
    "MALFORMED_UPLOAD": MalformedUploadError,
    "TOO_MANY_SLIDES": TooManySlidesError,
    "INSUFFICIENT_CREDITS": InsufficientCreditsError,
    "RATE_LIMITED": RateLimitedError,
    "JOB_NOT_FOUND": JobNotFoundError,
    "NOT_READY": NotReadyError,
    "OUTPUT_EXPIRED": OutputExpiredError,
}
_STATUS_TO_EXC: Dict[int, type] = {
    401: AuthenticationError,
    403: AuthenticationError,  # API_KEY_REQUIRED / ACCOUNT_DELETED (fallback if code absent)
    402: InsufficientCreditsError,
    404: JobNotFoundError,
    409: NotReadyError,
    410: OutputExpiredError,
    413: InvalidFileError,
    429: RateLimitedError,
}


def exception_for(
    *,
    status_code: int,
    code: Optional[str],
    message: str,
    retry_after: Optional[float] = None,
) -> Image2PPTError:
    """Build the mapped exception for an error envelope."""
    if status_code == 429:
        return RateLimitedError(
            message,
            status_code=429,
            code=code or "RATE_LIMITED",
            retry_after=retry_after,
        )
    exc_cls = _CODE_TO_EXC.get(code or "") or _STATUS_TO_EXC.get(status_code, Image2PPTError)
    return exc_cls(message, status_code=status_code, code=code)
