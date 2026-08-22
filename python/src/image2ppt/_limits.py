"""Upload size limits and batch planning.

The API caps the **file content of a single request** at 45MB. Going over that
is not a friendly failure: the check can only run after the whole body has been
received, and the network layer in front of the API gives up on an oversized
request before it ever gets there — so a client that sends too much sees the
connection die (a write timeout on a slow uplink, a broken pipe on a fast one)
with no error code and no explanation.

The fix is to never send too much. These limits, the pre-flight checks, and
``plan_batches`` let a client know a submission is too big *before* opening a
connection, and split a large pile of files into submittable batches.

There are three separate caps, and they fail in different ways: one file
(``MAX_FILE_BYTES``), the file content of one request (``MAX_UPLOAD_BYTES``), and
pages per job (``MAX_PAGES_PER_JOB``). ``BATCH_TARGET_BYTES`` is not a fourth cap —
it is how much ``plan_batches`` puts in one batch, deliberately under the real one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List

from .errors import InvalidFileError, TooManySlidesError

#: Server cap on **one** file. A file over this is rejected with
#: ``INVALID_FILE`` however it is submitted, so no amount of batching helps.
#: Keep in sync with the documented API contract.
MAX_FILE_BYTES = 35 * 1024 * 1024

#: Server cap on the **file content** of one request — boundaries, per-part headers
#: and filenames do not count towards it. Over this, the request is rejected
#: (413 ``PAYLOAD_TOO_LARGE``) — or, further up, cut off outright before the server
#: can answer at all. Keep in sync with the documented API contract.
MAX_UPLOAD_BYTES = 45 * 1024 * 1024

#: Byte budget for one auto-planned batch. **A splitting budget, not a cap** — the cap
#: is ``MAX_UPLOAD_BYTES``, and ``check_submission`` compares against that exactly.
#:
#: Deliberately below the cap, and the asymmetry is the point: starting one more batch
#: costs nothing, while refusing a submission the server would have accepted is a bug
#: in the guard. Nothing here needs the headroom — the planner measures the exact bytes
#: it will send — so this is margin, not correction. **Do not turn it into a cap.**
#: ``MAX_UPLOAD_BYTES`` is file content only; the multipart framing around it does not
#: count against the published limit, and a pre-flight that "leaves room" for framing
#: just makes the documented maximum unreachable.
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


def check_file_size(path: str, size: int) -> None:
    """Raise if one file is over the per-file cap, whatever else it travels with.

    Separate from ``check_submission`` because it is a property of the file, not
    of the request: a 40MB PDF fits under the 45MB request cap and would sail
    through batch planning, then be rejected by the server every single time. Fail
    on it locally instead of building a batch that can never succeed.

    Args:
        path: The file, named in the error so the caller knows which one.
        size: Its size as it will be uploaded.

    Raises:
        InvalidFileError: Over ``MAX_FILE_BYTES`` (``code="INVALID_FILE"``, the
            same code the server would answer with).
    """
    if size > MAX_FILE_BYTES:
        raise InvalidFileError(
            f"{path!r} is {format_bytes(size)}, over the "
            f"{format_bytes(MAX_FILE_BYTES)} per-file limit; the server rejects it "
            "however it is submitted, so splitting into batches will not help",
            code="INVALID_FILE",
        )


def check_submission(total_bytes: int, image_pages: int, pdf_files: int = 0) -> None:
    """Raise if a submission cannot succeed, before any bytes go on the wire.

    **The page check is a lower bound, not the server's verdict.** An image is
    exactly 1 page, but a PDF is however many pages it holds and the SDK does not
    parse PDFs (zero extra dependencies), so each one can only be counted as *at
    least* 1. That is enough to catch the combinations that are certain to fail —
    50 images plus any PDF is at least 51 pages, so it never had a chance — but a
    submission that passes here can still come back ``TOO_MANY_SLIDES`` from the
    server, because a 30-page PDF counted as 1 here and as 30 there. Passing this
    check means "not obviously doomed", not "will be accepted".

    Args:
        total_bytes: Sum of the file sizes that will be sent in this request.
        image_pages: Number of image files. Each is exactly 1 page.
        pdf_files: Number of PDFs (or other files whose page count is unknown to
            the client). Each counts as at least 1 page.

    Raises:
        TooManySlidesError: The minimum page count already exceeds what one job
            can hold.
        InvalidFileError: File content over the per-request cap
            (``code="PAYLOAD_TOO_LARGE"``).
    """
    min_pages = image_pages + pdf_files
    if min_pages > MAX_PAGES_PER_JOB:
        if pdf_files:
            counted = (
                f"{image_pages} images plus {pdf_files} "
                f"{'PDF' if pdf_files == 1 else 'PDFs'} (at least 1 page each) "
                f"is at least {min_pages} pages"
            )
        else:
            counted = f"{image_pages} images is {min_pages} pages"
        raise TooManySlidesError(
            f"{counted} in one submission, over the {MAX_PAGES_PER_JOB}-page-per-job "
            "limit; use submit_all() or convert_all() to split them into jobs "
            "automatically",
            code="TOO_MANY_SLIDES",
        )
    if total_bytes > MAX_UPLOAD_BYTES:
        raise InvalidFileError(
            f"these files add up to {format_bytes(total_bytes)}, over the "
            f"{format_bytes(MAX_UPLOAD_BYTES)} of file content one request may carry "
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
      - a batch holds at most ``MAX_PAGES_PER_JOB`` images. That count is exact,
        not a lower bound like ``check_submission``'s: a PDF always flushes the
        current batch and takes one of its own, so a batch being filled here only
        ever holds images, and an image is always exactly 1 page;
      - **every PDF gets a batch to itself.** The SDK does not parse PDFs (zero
        extra dependencies), so the client cannot know how many pages one holds.
        Mixed into a batch, an unknown page count could push the job over the
        page limit with no way to predict it. Alone, the job is exactly that
        one PDF and the server's own count decides;
      - input order is preserved, so the same files always plan the same way.

    Raises:
        InvalidFileError: A single file is over ``MAX_FILE_BYTES``. No batching can
            help — the server rejects that file however it is submitted.
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
        # Stricter than the request cap and checked first: a file over the per-file
        # limit is unsubmittable, not merely unbatchable.
        check_file_size(item.path, item.size)
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
