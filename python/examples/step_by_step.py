"""Step-by-step control: submit, poll yourself, then download.

Useful when you want to persist the job id, show progress, or run many jobs
concurrently instead of blocking on convert().

    export IMAGE2PPT_API_KEY=i2p_live_your_key
    uv run --with image2ppt python step_by_step.py slide1.png
"""

import os
import sys
import time

from image2ppt import Image2PPTClient, RateLimitedError


def main() -> int:
    api_key = os.environ.get("IMAGE2PPT_API_KEY")
    paths = sys.argv[1:]
    if not api_key or not paths:
        print("set IMAGE2PPT_API_KEY and pass file paths", file=sys.stderr)
        return 2

    client = Image2PPTClient(api_key=api_key)

    # Check the balance first.
    account = client.account()
    print(f"account {account['email']} — {account['credits']} credits available")

    # Submit, retrying politely if rate limited.
    while True:
        try:
            job = client.submit(paths, aspect_ratio="auto")
            break
        except RateLimitedError as e:
            wait_s = e.retry_after if e.retry_after is not None else 5
            print(f"rate limited, retrying in {wait_s}s")
            time.sleep(wait_s)

    print(f"submitted job {job.job_id} — {job.slide_count} pages, {job.credits_reserved} credits reserved")

    # Poll yourself (or just call client.wait(job.job_id) to let the SDK do it).
    while True:
        job = client.get_job(job.job_id)
        print(f"  status={job.status} progress={job.progress}%")
        if job.is_terminal:
            break
        time.sleep(5)

    if job.is_failed:
        print(f"failed: {(job.error or {}).get('code')}", file=sys.stderr)
        return 1

    client.download(job.job_id, "out.pptx")
    print(f"saved out.pptx — {job.credits_used} credits used, {job.credits_refunded} refunded")

    # Which pages actually made it. Absent (None) for a job that reported no
    # per-page ledger; an entry per page otherwise.
    for page in job.page_results or []:
        if page.status == "converted":
            continue
        if page.error.code == "PAGE_NOT_ATTEMPTED":
            where = "not in the deck at all"
        else:
            where = "in the deck as the original image, not editable"
        retry = "worth resubmitting" if page.error.retryable else "resubmitting will not help"
        print(f"  page {page.page_number}: {where} ({page.error.code}, {retry})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
