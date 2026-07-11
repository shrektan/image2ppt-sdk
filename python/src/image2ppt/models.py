"""Data models returned by the client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional


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
            download_url=data.get("downloadUrl"),
            error=data.get("error"),
            raw=data,
        )
