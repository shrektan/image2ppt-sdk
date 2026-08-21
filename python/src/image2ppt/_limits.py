"""Upload size limits and batch planning.

The API caps the **file content of a single request** at 45MB. Going over that
is not a friendly failure: the check can only run after the whole body has been
received, and the network layer in front of the API gives up on an oversized
request before it ever gets there — so a client that sends too much sees the
connection die (a write timeout on a slow uplink, a broken pipe on a fast one)
with no error code and no explanation.

The fix is to never send too much. These limits, the pre-flight check, and
``plan_batches`` let a client know a submission is too big *before* opening a
connection, and split a large pile of files into submittable batches.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List

from .errors import InvalidFileError, TooManySlidesError

#: Server cap on the file content of one request. Over this, the request is
#: rejected (413 ``PAYLOAD_TOO_LARGE``) — or cut off outright before the server
#: can answer at all. Keep in sync with the documented API contract.
MAX_UPLOAD_BYTES = 45 * 1024 * 1024

#: Target ceiling for one auto-planned batch. Deliberately *below*
#: ``MAX_UPLOAD_BYTES``: what travels on the wire is a multipart body, so the
#: request is always somewhat larger than the file bytes it carries (boundaries,
#: per-part headers, filenames), and the client-side image compression that
#: produced these sizes is not byte-for-byte reproducible. The gap absorbs both
#: so a planned batch does not land just over the cap.
BATCH_TARGET_BYTES = 40 * 1024 * 1024

#: Server cap on pages per job. An image is 1 page; a PDF counts as its own page
#: count. Keep in sync with the documented API contract.
MAX_PAGES_PER_JOB = 50


@dataclass(frozen=True)
class UploadItem:
    """One file to upload, with the size it will actually occupy in the request.

    ``size`` is the wire size, not necessarily the size on disk: images are
    compressed before upload, so it is the compressed length.

    ``is_pdf`` marks a file whose page count is unknown to the client (the SDK
    does not parse PDFs). Such a file is never mixed into a batch with others.
    """

    path: str
    size: int
    is_pdf: bool


def format_bytes(size: int) -> str:
    """Format a byte count for human-readable error messages.

    Stays honest below a megabyte. Rounding everything to MB makes a submission one
    byte over the cap read as "45.0MB, over the 45.0MB limit (0.0MB too much)" — a
    message that contradicts itself and looks like the check is broken.
    """
    if size < 1024:
        return f"{size}B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f}KB"
    return f"{size / (1024 * 1024):.1f}MB"


def check_submission(total_bytes: int, image_pages: int) -> None:
    """Raise if a submission cannot succeed, before any bytes go on the wire.

    Args:
        total_bytes: Sum of the file sizes that will be sent in this request.
        image_pages: Number of image files (each is exactly 1 page). PDFs are
            excluded — their page count is only known server-side.

    Raises:
        TooManySlidesError: More images than one job can hold.
        InvalidFileError: File content over the per-request cap
            (``code="PAYLOAD_TOO_LARGE"``).
    """
    if image_pages > MAX_PAGES_PER_JOB:
        raise TooManySlidesError(
            f"{image_pages} images in one submission, over the "
            f"{MAX_PAGES_PER_JOB}-page-per-job limit; use submit_all() or "
            "convert_all() to split them into jobs automatically",
            code="TOO_MANY_SLIDES",
        )
    if total_bytes > MAX_UPLOAD_BYTES:
        raise InvalidFileError(
            f"these files add up to {format_bytes(total_bytes)}, over the "
            f"{format_bytes(MAX_UPLOAD_BYTES)} limit for one request "
            f"({format_bytes(total_bytes - MAX_UPLOAD_BYTES)} too much). "
            "Send fewer files per call, or use submit_all() / convert_all() to "
            "split them into batches automatically",
            code="PAYLOAD_TOO_LARGE",
        )


def plan_batches(items: Iterable[UploadItem]) -> List[List[UploadItem]]:
    """Split files into batches that each fit in one submission.

    Pure function: no file system, no network. Same input, same output.

    Rules:
      - a batch holds at most ``BATCH_TARGET_BYTES`` of file content;
      - a batch holds at most ``MAX_PAGES_PER_JOB`` images;
      - **every PDF gets a batch to itself.** The SDK does not parse PDFs (zero
        extra dependencies), so the client cannot know how many pages one holds.
        Mixed into a batch, an unknown page count could push the job over the
        page limit with no way to predict it. Alone, the job is exactly that
        one PDF and the server's own count decides;
      - input order is preserved, so the same files always plan the same way.

    Raises:
        InvalidFileError: A single file is over ``MAX_UPLOAD_BYTES``. No batching
            can help — it does not fit in any request on its own.
    """
    batches: List[List[UploadItem]] = []
    current: List[UploadItem] = []
    current_bytes = 0

    def flush() -> None:
        nonlocal current, current_bytes
        if current:
            batches.append(current)
            current = []
            current_bytes = 0

    for item in items:
        if item.size > MAX_UPLOAD_BYTES:
            raise InvalidFileError(
                f"{item.path!r} is {format_bytes(item.size)} on its own, over the "
                f"{format_bytes(MAX_UPLOAD_BYTES)} limit for one request; it cannot "
                "be uploaded in any batch",
                code="PAYLOAD_TOO_LARGE",
            )
        if item.is_pdf:
            flush()
            batches.append([item])
            continue
        # A file bigger than the batch target still gets uploaded — alone. The
        # `current` guard means we only start a new batch to make room, never
        # refuse to place an item.
        if current and (
            current_bytes + item.size > BATCH_TARGET_BYTES
            or len(current) + 1 > MAX_PAGES_PER_JOB
        ):
            flush()
        current.append(item)
        current_bytes += item.size

    flush()
    return batches
