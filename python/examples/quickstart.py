"""Quickstart: hand image2ppt a batch of files, get back one editable PPTX.

    export IMAGE2PPT_API_KEY=i2p_live_your_key
    uv run --with image2ppt python quickstart.py slide1.png slide2.png report.pdf
"""

import os
import sys

from image2ppt import Image2PPTClient, Image2PPTError, JobFailedError


def main() -> int:
    api_key = os.environ.get("IMAGE2PPT_API_KEY")
    if not api_key:
        print("set IMAGE2PPT_API_KEY first", file=sys.stderr)
        return 2

    paths = sys.argv[1:]
    if not paths:
        print("usage: quickstart.py <file> [<file> ...]", file=sys.stderr)
        return 2

    client = Image2PPTClient(api_key=api_key)
    try:
        job = client.convert(paths, dest_path="out.pptx", aspect_ratio="16:9")
    except JobFailedError as e:
        print(f"conversion failed: {e.code} — {e.message}", file=sys.stderr)
        return 1
    except Image2PPTError as e:
        print(f"request error: {e}", file=sys.stderr)
        return 1

    print(f"saved out.pptx — {job.slide_count} pages, {job.credits_used} credits used")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
