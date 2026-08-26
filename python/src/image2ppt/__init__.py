"""Official Python client for the image2ppt API.

Convert images and PDFs into editable PowerPoint (.pptx) decks.

    from image2ppt import Image2PPTClient

    client = Image2PPTClient(api_key="i2p_live_...")
    job = client.convert(["slide1.png", "report.pdf"], dest_path="out.pptx")
    print("credits used:", job.credits_used)

See https://github.com/shrektan/image2ppt-sdk for docs and examples.
"""

from __future__ import annotations

from ._limits import (
    BATCH_TARGET_BYTES,
    MAX_FILE_BYTES,
    MAX_PAGES_PER_JOB,
    MAX_UPLOAD_BYTES,
    UploadItem,
    check_file_size,
    check_submission,
    plan_batches,
)
from .client import DEFAULT_BASE_URL, Image2PPTClient
from .errors import (
    AuthenticationError,
    Image2PPTError,
    Image2PPTTimeoutError,
    InsufficientCreditsError,
    InvalidAspectRatioError,
    InvalidFileError,
    JobAlreadyFinishedError,
    JobCancelledError,
    JobFailedError,
    JobNotFoundError,
    MalformedUploadError,
    NoFilesError,
    NotReadyError,
    OutputExpiredError,
    PageRateExceededError,
    RateLimitedError,
    TooManySlidesError,
    UploadAbortedError,
)
from .models import CancellationResult, Job
from ._version import __version__

__all__ = [
    "Image2PPTClient",
    "Job",
    "CancellationResult",
    "DEFAULT_BASE_URL",
    "MAX_FILE_BYTES",
    "MAX_UPLOAD_BYTES",
    "BATCH_TARGET_BYTES",
    "MAX_PAGES_PER_JOB",
    "UploadItem",
    "check_file_size",
    "check_submission",
    "plan_batches",
    "Image2PPTError",
    "AuthenticationError",
    "InvalidFileError",
    "UploadAbortedError",
    "MalformedUploadError",
    "NoFilesError",
    "InvalidAspectRatioError",
    "PageRateExceededError",
    "TooManySlidesError",
    "InsufficientCreditsError",
    "RateLimitedError",
    "JobNotFoundError",
    "JobAlreadyFinishedError",
    "JobCancelledError",
    "NotReadyError",
    "OutputExpiredError",
    "JobFailedError",
    "Image2PPTTimeoutError",
    "__version__",
]
