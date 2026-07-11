"""Exception hierarchy for the image2ppt client.

Every error carries the HTTP ``status_code``, the server error ``code`` (from the
``{"error": {"code", "message"}}`` envelope), and a human-readable ``message``.
Branch on ``code``, not ``message`` — messages may be reworded.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


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
    """A file was rejected: unsupported format or over the 35MB per-file limit (400)."""


class TooManySlidesError(Image2PPTError):
    """The submission exceeds the 50-page-per-job limit (400 TOO_MANY_SLIDES)."""


class InsufficientCreditsError(Image2PPTError):
    """Not enough available credits to cover the submission (402)."""


class RateLimitedError(Image2PPTError):
    """Rate limited (429 RATE_LIMITED).

    ``retry_after`` is the server-suggested wait in seconds (from the
    ``Retry-After`` header); retry after that long.
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
    "TOO_MANY_SLIDES": TooManySlidesError,
    "INSUFFICIENT_CREDITS": InsufficientCreditsError,
    "RATE_LIMITED": RateLimitedError,
    "JOB_NOT_FOUND": JobNotFoundError,
    "NOT_READY": NotReadyError,
    "OUTPUT_EXPIRED": OutputExpiredError,
}
_STATUS_TO_EXC: Dict[int, type] = {
    401: AuthenticationError,
    402: InsufficientCreditsError,
    404: JobNotFoundError,
    409: NotReadyError,
    410: OutputExpiredError,
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
