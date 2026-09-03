"""Data models returned by the client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .errors import MalformedResponseError


@dataclass
class CancellationResult:
    """Result of requesting graceful cancellation for a conversion job."""

    job_id: str
    cancellation_requested: bool
    finalizing: bool
    raw: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CancellationResult":
        """Build the result, or raise ``MalformedResponseError`` if the envelope is bad.

        These three fields are the whole documented response, so a body missing one
        is not something a caller can act on. It still has to arrive as an
        ``Image2PPTError``: the READMEs tell callers that catching that one class
        covers the client, and a bare ``KeyError`` would walk straight through it.
        """
        if not isinstance(data, dict):
            raise MalformedResponseError(
                "malformed cancellation response, expected a JSON object"
            )
        missing = [k for k in ("jobId", "cancellationRequested", "finalizing") if k not in data]
        if missing:
            raise MalformedResponseError(
                f"malformed cancellation response, missing {', '.join(missing)}"
            )
        return cls(
            job_id=data["jobId"],
            cancellation_requested=bool(data["cancellationRequested"]),
            finalizing=bool(data["finalizing"]),
            raw=data,
        )


@dataclass
class PageError:
    """Why one page did not convert.

    ``code`` is what you branch on; ``message`` is a sentence written for people
    and may be reworded or translated at any time. The codes the contract defines
    for a page today are:

    - ``CONVERSION_FAILED`` — the page was attempted and did not succeed.
    - ``CONVERSION_TIMEOUT`` — the page was cut off after exceeding its time budget.
    - ``PAGE_NOT_ATTEMPTED`` — the page never started, because the job ended first.

    Treat a ``code`` you do not recognise as ``CONVERSION_FAILED``: the set may
    grow, and that is the safe reading of any new member.

    ``retryable`` says whether submitting the same image again could succeed.
    Every code above carries ``True`` today — **branch on the field anyway**, since
    a code added later may carry ``False``.
    """

    code: str
    message: str
    retryable: bool
    raw: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Any) -> "PageError":
        """Build a ``PageError``, tolerating an unfamiliar ``code`` and extra fields.

        Lenient on purpose: the entry itself is what the contract guarantees, so a
        surprise *inside* ``error`` should not cost you the rest of the ledger. A
        ``code`` that is missing reads as ``CONVERSION_FAILED``, which is the
        contract's own rule for a code you cannot place; a missing ``retryable``
        reads as ``False``, the answer that does not send anyone into a retry loop
        on a guess. A recognised ``code`` is passed through exactly as it came —
        nothing is rewritten to a value the server did not send.
        """
        fields: Dict[str, Any] = data if isinstance(data, dict) else {}
        return cls(
            code=str(fields.get("code") or "CONVERSION_FAILED"),
            message=str(fields.get("message") or ""),
            retryable=bool(fields.get("retryable", False)),
            raw=data if isinstance(data, dict) else None,
        )


@dataclass
class PageResult:
    """What happened to one page of the deck.

    ``page_number`` is 1-based and matches the order the files were submitted in
    (a PDF contributes its pages in their own order). ``status`` is ``converted``
    when the page became editable content and ``failed`` when it did not; treat
    any other value as ``failed``.

    A failed page ends up one of two ways, and the difference matters:

    - ``error.code == "PAGE_NOT_ATTEMPTED"`` — the page **is not in the delivered
      deck at all**. It never started, and its credit was refunded.
    - any other code — the page **is** in the deck, as the original image rather
      than editable content.
    """

    page_number: int
    status: str  # converted | failed
    error: Optional[PageError] = None
    raw: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PageResult":
        """Build one entry; ``pageNumber`` and ``status`` are required by the contract."""
        if not isinstance(data, dict):
            raise MalformedResponseError(
                "malformed page result, expected a JSON object"
            )
        missing = [k for k in ("pageNumber", "status") if k not in data]
        if missing:
            raise MalformedResponseError(
                f"malformed page result, missing {', '.join(missing)}"
            )
        try:
            page_number = int(data["pageNumber"])
        except (TypeError, ValueError) as exc:
            raise MalformedResponseError(
                f"malformed page result, pageNumber is not a number: {data['pageNumber']!r}"
            ) from exc
        raw_error = data.get("error")
        return cls(
            page_number=page_number,
            status=str(data["status"]),
            error=PageError.from_dict(raw_error) if raw_error is not None else None,
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
    #: Per-page outcome, in page order, with one entry per page (``len ==
    #: slide_count``).
    #:
    #: ``None`` and ``[]`` mean different things and neither is a stand-in for the
    #: other. ``None`` means **the job did not report a ledger**: it is still
    #: running (while it is, "this page failed" and "this page has not had its turn"
    #: are indistinguishable), or it is one of the small number of jobs submitted
    #: before September 2026, which have no per-page record. An empty list would
    #: mean a job with no pages. Check ``is not None`` before iterating.
    #:
    #: ``credits_refunded`` tells you how many pages did not convert; this tells you
    #: which ones — and, through ``PageResult.error.code``, whether each missing
    #: page is in the deck as its original image or absent from it entirely.
    #:
    #: Appended last on purpose: the field order of this dataclass is a positional
    #: constructor signature people may already be relying on.
    page_results: Optional[List[PageResult]] = None

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
        """Build a Job from server JSON; handles both submit and status shapes.

        ``jobId`` and ``status`` are guaranteed by the contract, so a body without
        them is malformed rather than a job with missing pieces — and it has to
        arrive as an ``Image2PPTError``, the class the READMEs tell callers to
        catch, instead of a bare ``KeyError``. Same standard as
        ``CancellationResult.from_dict``, for the same reason.

        The job-level ``error.code`` has only two documented values,
        ``JOB_CANCELLED`` and ``CONVERSION_FAILED``; treat anything else as
        ``CONVERSION_FAILED``. The finer per-page reasons live in ``page_results``
        and deliberately do not appear here.
        """
        if not isinstance(data, dict):
            raise MalformedResponseError("malformed job response, expected a JSON object")
        missing = [k for k in ("jobId", "status") if k not in data]
        if missing:
            raise MalformedResponseError(
                f"malformed job response, missing {', '.join(missing)}"
            )
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
            page_results=_parse_page_results(data.get("pageResults")),
            raw=data,
        )


def _parse_page_results(value: Any) -> Optional[List[PageResult]]:
    """Parse ``pageResults``, keeping "absent" distinct from "empty"."""
    if value is None:
        return None
    if not isinstance(value, list):
        raise MalformedResponseError("malformed job response, pageResults must be an array")
    return [PageResult.from_dict(entry) for entry in value]
