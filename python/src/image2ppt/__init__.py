"""Official Python client for the image2ppt API.

Convert images and PDFs into editable PowerPoint (.pptx) decks.

    from image2ppt import Image2PPTClient

    client = Image2PPTClient(api_key="i2p_live_...")
    job = client.convert(["slide1.png", "report.pdf"], dest_path="out.pptx")
    print("credits used:", job.credits_used)

See https://github.com/shrektan/image2ppt-sdk for docs and examples.
"""

from __future__ import annotations

from .client import DEFAULT_BASE_URL, Image2PPTClient
from .errors import (
    AuthenticationError,
    Image2PPTError,
    Image2PPTTimeoutError,
    InsufficientCreditsError,
    InvalidFileError,
    JobFailedError,
    JobNotFoundError,
    NotReadyError,
    OutputExpiredError,
    RateLimitedError,
    TooManySlidesError,
)
from .models import Job

__version__ = "0.1.0"

__all__ = [
    "Image2PPTClient",
    "Job",
    "DEFAULT_BASE_URL",
    "Image2PPTError",
    "AuthenticationError",
    "InvalidFileError",
    "TooManySlidesError",
    "InsufficientCreditsError",
    "RateLimitedError",
    "JobNotFoundError",
    "NotReadyError",
    "OutputExpiredError",
    "JobFailedError",
    "Image2PPTTimeoutError",
    "__version__",
]
