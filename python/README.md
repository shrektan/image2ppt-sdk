# image2ppt — Python client

Official Python client for the [image2ppt](https://image2ppt.com) API. Turn a batch of images or PDF pages into one **editable** PowerPoint (`.pptx`).

## Install

```bash
pip install image2ppt
```

Requires Python 3.9+. Depends on `requests` and `Pillow` (Pillow powers optional client-side image pre-compression — see below).

## Get an API key

Sign in at [image2ppt.com](https://image2ppt.com), open **Developer / API** from the account menu, and create a key (looks like `i2p_live_xxxx`). It's shown in full **once** — save it. API access is available to accounts with credits.

> **Server-side only.** Keep your key on your backend. Never embed it in a browser, mobile app, or anything a user can inspect.

## Quick start

One shot — submit, wait, download:

```python
from image2ppt import Image2PPTClient

client = Image2PPTClient(api_key="i2p_live_your_key")

job = client.convert(
    ["slide1.png", "slide2.png", "report.pdf"],
    dest_path="out.pptx",
    locale="zh-CN",       # optional: "zh-CN" (default) or "en"
    aspect_ratio="16:9",  # optional: "auto" (default) / "16:9" / "4:3"
)
print("done — credits used:", job.credits_used, "refunded:", job.credits_refunded)
```

Step by step, if you want to control polling:

```python
job = client.submit(["slide1.png"], aspect_ratio="4:3")
print("job:", job.job_id, "credits reserved:", job.credits_reserved)

job = client.wait(job.job_id, poll_interval=5, timeout=1800)
client.download(job.job_id, "out.pptx")
```

Check your balance:

```python
info = client.account()
print(info["email"], "credits:", info["credits"])
```

## How it works

- **Async.** `submit` returns a job id immediately; conversion runs in the background. A single page typically takes ~2 minutes; 90% of jobs finish within 3.
- **One job = one PPTX.** All files in a submission are merged into a single deck, in upload order.
- **Billed per page.** 1 page = 1 credit, reserved at submit and settled on completion. If some pages fail but others succeed, the job still `completed`s with the good pages and the failed pages' credits are refunded (`credits_refunded`).
- **Limits.** Each file ≤ 35MB; total ≤ 50 pages per job (images count as 1, PDFs as their page count).
- **Client-side pre-compression.** Images are compressed to the server's spec before upload (≤2000px, ≤1MB, JPEG), so the server's own pass is a no-op and you send fewer bytes. PDFs are uploaded as-is and rendered server-side.

## Rate limits

Per account (all keys share the budget): ≤ 10 concurrent jobs, ≤ 60 pages/minute submitted. Over the limit returns `429` with a `Retry-After` hint. `wait()` handles 429 backoff for you automatically. If you call `submit()` directly, catch `RateLimitedError` and honor `retry_after`:

```python
import time
from image2ppt import RateLimitedError

while True:
    try:
        job = client.submit(paths)
        break
    except RateLimitedError as e:
        time.sleep(e.retry_after if e.retry_after is not None else 5)
```

## Errors

Every exception subclasses `Image2PPTError` and carries `status_code`, `code`, and `message`. Branch on `code`, not `message`.

| Exception | HTTP | code |
|---|---|---|
| `AuthenticationError` | 401 / 403 | `INVALID_API_KEY`, `API_KEY_REQUIRED`, `ACCOUNT_DELETED` |
| `InvalidFileError` | 400 | `INVALID_FILE` |
| `TooManySlidesError` | 400 | `TOO_MANY_SLIDES` |
| `InsufficientCreditsError` | 402 | `INSUFFICIENT_CREDITS` |
| `RateLimitedError` | 429 | `RATE_LIMITED` (has `retry_after`) |
| `JobNotFoundError` | 404 | `JOB_NOT_FOUND` |
| `NotReadyError` | 409 | `NOT_READY` |
| `OutputExpiredError` | 410 | `OUTPUT_EXPIRED` |
| `JobFailedError` | — | job's `error.code` (raised by `wait()`; `e.job` is the snapshot) |
| `Image2PPTTimeoutError` | — | — (`wait()` exceeded its `timeout`; job may still be running) |

```python
from image2ppt import Image2PPTError, JobFailedError

try:
    job = client.convert(paths, "out.pptx")
except JobFailedError as e:
    print("conversion failed:", e.code, e.message)
except Image2PPTError as e:
    print("request error:", e.status_code, e.code, e.message)
```

## Full API reference

See [../docs/api.md](../docs/api.md) for the complete HTTP contract (endpoints, fields, error codes). 中文版：[../docs/api.zh.md](../docs/api.zh.md)。

## License

[MIT](./LICENSE)
