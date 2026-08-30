"""Data models returned by the client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from .errors import Image2PPTError


@dataclass
class CancellationResult:
    """Result of requesting graceful cancellation for a conversion job."""

    job_id: str
    cancellation_requested: bool
    finalizing: bool
    raw: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CancellationResult":
        """Build the result, or raise ``Image2PPTError`` if the envelope is malformed.

        These three fields are the whole documented response, so a body missing one
        is not something a caller can act on. It still has to arrive as an
        ``Image2PPTError``: the READMEs tell callers that catching that one class
        covers the client, and a bare ``KeyError`` would walk straight through it.
        """
        if not isinstance(data, dict):
            raise Image2PPTError("malformed cancellation response, expected a JSON object")
        missing = [k for k in ("jobId", "cancellationRequested", "finalizing") if k not in data]
        if missing:
            raise Image2PPTError(
                f"malformed cancellation response, missing {', '.join(missing)}"
            )
        return cls(
            job_id=data["jobId"],
            cancellation_requested=bool(data["cancellationRequested"]),
            finalizing=bool(data["finalizing"]),
            raw=data,
        )


@dataclass
class Job:
    """A snapshot of a conversion job's state.

    Which fields are populated depends on the source: a ``submit`` response only
    carries ``credits_reserved``; a ``get_job`` response carries
    ``credits_used`` / ``credits_refunded`` / ``download_url`` and friends.
    """

    job_id: str
    status: str  # pending | processing | completed | failed
    slide_count: Optional[int] = None
    progress: Optional[int] = None  # 0-100
    credits_reserved: Optional[int] = None  # submit response: credits locked
    credits_used: Optional[int] = None  # settled: credits actually charged
    credits_refunded: Optional[int] = None  # partial success: refunded failed pages
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    download_url: Optional[str] = None  # completed only; relative path
    error: Optional[Dict[str, Any]] = None  # failed only; {code, message}
    raw: Optional[Dict[str, Any]] = None  # raw response body, for forward-compat fields
    cancellation_requested: bool = False

    @property
    def is_completed(self) -> bool:
        """Whether the job finished successfully (deliverable downloadable)."""
        return self.status == "completed"

    @property
    def is_failed(self) -> bool:
        """Whether the job failed."""
        return self.status == "failed"

    @property
    def is_terminal(self) -> bool:
        """Whether the job reached a terminal state (completed or failed)."""
        return self.status in ("completed", "failed")

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Job":
        """Build a Job from server JSON; handles both submit and status shapes."""
        return cls(
            job_id=data["jobId"],
            status=data["status"],
            slide_count=data.get("slideCount"),
            progress=data.get("progress"),
            credits_reserved=data.get("creditsReserved"),
            credits_used=data.get("creditsUsed"),
            credits_refunded=data.get("creditsRefunded"),
            created_at=data.get("createdAt"),
            completed_at=data.get("completedAt"),
            cancellation_requested=bool(data.get("cancellationRequested", False)),
            download_url=data.get("downloadUrl"),
            error=data.get("error"),
            raw=data,
        )
