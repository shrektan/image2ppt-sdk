"""Data models returned by the client."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from .errors import MalformedResponseError


def _required(data: Any, keys: Sequence[str], what: str) -> Dict[str, Any]:
    """Check a response envelope is an object carrying every guaranteed field.

    One helper for all three envelopes — a job, a cancellation result, a page
    entry. The check used to be hand-written at each of them, and the copies drifted
    apart from each other and from the Node client's, which is exactly the kind of
    disagreement two clients for one API cannot afford.

    **A field counts as missing when the key is absent or its value is null.** The
    two mean the same thing to a caller: there is no value to act on. A key present
    with ``null`` used to pass, and the model was then built with ``None`` where the
    contract promised a job id.

    The test is ``is None`` rather than a falsiness test, and that matters:
    ``cancellationRequested`` and ``finalizing`` are booleans whose ``False`` is a
    real answer the service sends. Rejecting it would fail the response that says
    "no, the job is not still winding down".
    """
    if not isinstance(data, dict):
        raise MalformedResponseError(f"malformed {what}, expected a JSON object")
    missing = [key for key in keys if data.get(key) is None]
    if missing:
        raise MalformedResponseError(f"malformed {what}, missing {', '.join(missing)}")
    return data


def _is_whole_number(value: Any) -> bool:
    """Whether ``value`` is a real number whose value is a whole one.

    Checked rather than coerced. A page number arriving as the *string* ``"3"``
    used to be quietly converted, so a service (or a proxy) sending the wrong type
    was covered up here instead of reported; the Node client refuses it, and
    silently disagreeing about the same body is worse than either answer.

    JSON's ``3`` and ``3.0`` are the same number and JavaScript cannot tell them
    apart, so both are accepted. ``True`` is not: Python's booleans are integers
    and JavaScript's are not numbers at all, so passing one here would be a
    difference of language rather than of contract.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer()
    return True


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

        ``cancellationRequested: false`` and ``finalizing: false`` are perfectly
        good answers and pass — see ``_required`` for why that is worth stating.
        """
        data = _required(
            data, ("jobId", "cancellationRequested", "finalizing"), "cancellation response"
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
        ``code`` that is missing, empty, or not a string reads as
        ``CONVERSION_FAILED``, which is the contract's own rule for a code you
        cannot place; a ``message`` that is not a string reads as empty; anything
        but a real ``True`` reads as not retryable. A usable ``code`` is passed
        through exactly as it came — nothing is rewritten to a value the server did
        not send.

        Every rule here is pinned identically in the Node client. One body must not
        mean two different things depending on which SDK read it.
        """
        raw: Optional[Dict[str, Any]] = data if isinstance(data, dict) else None
        fields: Dict[str, Any] = raw if raw is not None else {}
        code = fields.get("code")
        message = fields.get("message")
        return cls(
            code=code if isinstance(code, str) and code else "CONVERSION_FAILED",
            # Not ``str(...)``: a number is not a sentence anybody wants to show a
            # person, so it reads as no message rather than as "42".
            message=message if isinstance(message, str) else "",
            # A real boolean, never truthiness. A flag we cannot read is not a
            # licence to re-upload, so anything else — a missing field included —
            # is False: telling a caller "try this page again" on a guess costs
            # them credits, telling them "don't" costs them nothing they cannot
            # recover by asking again themselves.
            retryable=fields.get("retryable") is True,
            raw=raw,
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
        """Build one entry; ``pageNumber`` and ``status`` are required by the contract.

        Their *types* are checked rather than cast through. A page number arriving
        as ``"3"`` would otherwise be quietly converted, and a status arriving as a
        number would be stringified into something that matches neither
        ``converted`` nor ``failed`` — both of them a wrong type covered up rather
        than reported, and both places where this client used to disagree with the
        Node one about the very same body.
        """
        data = _required(data, ("pageNumber", "status"), "pageResults entry")
        if not _is_whole_number(data["pageNumber"]):
            raise MalformedResponseError(
                f"malformed pageResults entry, pageNumber is not a number: "
                f"{data['pageNumber']!r}"
            )
        if not isinstance(data["status"], str):
            raise MalformedResponseError(
                "malformed pageResults entry, status is not a string: "
                f"{data['status']!r}"
            )
        raw_error = data.get("error")
        return cls(
            page_number=int(data["pageNumber"]),
            status=data["status"],
            # An ``error`` that is present but is not an object says nothing this
            # model could report, so it reads as absent. Inventing a fully-defaulted
            # ``PageError`` from it would put a ``CONVERSION_FAILED`` on the page
            # that the service never sent.
            error=PageError.from_dict(raw_error) if isinstance(raw_error, dict) else None,
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
    #: That shape is what the API documents, and this client passes the ledger
    #: through as it arrived rather than cross-checking it against
    #: ``slide_count``. Refusing a job over a ledger that did not add up would
    #: cost the caller a deck they can actually download, which is the worse
    #: trade. Check the length yourself if your own logic depends on it.
    #:
    #: ``None`` and ``[]`` mean different things and neither is a stand-in for the
    #: other. ``None`` means **the job did not report a ledger**: it is still
    #: running (while it is, "this page failed" and "this page has not had its turn"
    #: are indistinguishable), or it was submitted before September 2026, and
    #: those jobs have no per-page record. An empty list would
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
        data = _required(data, ("jobId", "status"), "job response")
        # Same rule as a page entry's ``error`` one level down: a value that is
        # present but is not an object carries nothing this model could report, so
        # it reads as absent. Passing it through instead let a string or a list
        # reach ``wait()``, which asks it for ``code`` and died on a bare
        # ``AttributeError`` — the one kind of failure this client promises never to
        # hand back. The original is still on ``raw``.
        raw_error = data.get("error")
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
            error=raw_error if isinstance(raw_error, dict) else None,
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
