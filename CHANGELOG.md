# Changelog

All notable changes to the image2ppt SDKs (Python + TypeScript) are documented
here. The two clients share a single version number.

## 0.2.0

Both clients now refuse an oversized submission locally instead of letting it die
on the wire, and can split a large pile of files into batches on their own.

### Added
- **Both clients** — a pre-flight size check on `submit()`. The files in one
  request must add up to ≤ 45MB; over that the client raises `InvalidFileError`
  (`PAYLOAD_TOO_LARGE`) **before opening a connection**. This limit could not be
  reported properly from the server side: an oversized request is cut off by the
  network before the API can answer, so callers used to see a bare write timeout
  or broken pipe with no error code.
- **Both clients** — `submit_all()` / `submitAll()` and `convert_all()` /
  `convertAll()`: split files into batches that each fit a request (≤ 40MB of file
  content, ≤ 50 images, every PDF in a batch of its own) and create one job per
  batch. **These produce one PPTX per batch, not one merged deck**; `convert()` is
  unchanged (one job, one PPTX). `convert_all()` / `convertAll()` write
  `part-01.pptx`, `part-02.pptx`, ... into a destination directory.
- **Both clients** — the per-file 35MB limit is now enforced locally too, by both
  `submit()` and batch planning. It is *stricter* than the per-request limit, so a
  40MB PDF used to pass the size check and get planned into a batch that the
  server would reject with `INVALID_FILE` every single time. The error names the
  file and its size.
- **Both clients** — the page pre-check counts each PDF as **at least 1 page**.
  It used to ignore PDFs entirely, so "50 images plus any PDF" passed locally and
  was certain to be rejected server-side. The check is a lower bound, not the
  server's verdict — the SDKs do not parse PDFs — and the docs now say so.
- **Both clients** — the limits and the batch planner are public: `MAX_FILE_BYTES`,
  `MAX_UPLOAD_BYTES`, `BATCH_TARGET_BYTES`, `MAX_PAGES_PER_JOB`, `UploadItem`,
  `check_file_size()` / `checkFileSize()`, `check_submission()` /
  `checkSubmission()`, `plan_batches()` / `planBatches()`.
- **Both clients** — **submissions are never retried automatically**, and the
  docs now say so. A connection error proves only that the exchange broke, not
  that the request body was incomplete: the server may have received all of it,
  created the job and reserved credits, and lost the connection while answering.
  Retrying that charges twice, and telling the two apart needs an idempotency key
  the API does not offer. Transport errors are raised as-is — check `account()` or
  your job list before resending. (Rate limiting is different and *is* retried: a
  429 is the server explicitly saying it did not take the submission.)
- **Both clients** — the batch calls **wait out rate limits instead of failing**.
  A pile big enough to need batching is a pile big enough to hit the per-minute
  page quota, so a 429 mid-pile is normal; each one is retried after its
  `Retry-After` (5s if the header is absent), capped by `rate_limit_max_wait` /
  `rateLimitMaxWaitMs` (default 30 min). Retrying a 429 is free — the server is
  saying it did not take the submission.
- **Both clients** — when a batch call fails partway, the jobs it already created
  come back on the exception as `submitted_jobs` / `submittedJobs`. Those jobs are
  running with credits already reserved; collect them instead of resubmitting.
- **Both clients** — `PAYLOAD_TOO_LARGE` and HTTP 413 map to `InvalidFileError`.

### Fixed
- **Both clients** — `convert_all()` / `convertAll()` create the destination
  directory **and prove it writable** before submitting anything, by writing and
  removing a probe file. Doing this afterwards — or only creating the directory,
  which silently succeeds on an existing read-only one — meant an unusable
  destination failed only once every job existed with credits reserved and nowhere
  to put the output.
- **Python** — `__version__` said `0.1.0` while the package was `0.1.1`. Both now
  come from the same release number, with a test guarding against the drift.

## 0.1.1

Bug-fix release hardening both clients on the resilient paths. No API changes.

### Fixed
- **TypeScript** — request timeouts now raise `Image2PPTError` instead of a raw
  `DOMException`, so a slow large upload/download no longer crashes callers that
  only catch `Image2PPTError`.
- **Both clients** — `wait()` now retries a transient server (5xx) or network
  error during polling instead of aborting the whole conversion; client errors
  (4xx) still surface immediately.
- **TypeScript** — `download()` streams the PPTX to disk instead of buffering the
  whole file in memory, avoiding OOM on large decks.
- **Python** — unreadable images (corrupt/truncated, or over Pillow's
  decompression-bomb limit) now raise `InvalidFileError` instead of a raw Pillow
  exception.
- **Python** — images larger than 2000px are always downscaled to honor the
  documented ≤2000px upload spec, even when the re-encode isn't smaller.
- **Both clients** — HTTP 403 without a recognized error code now maps to
  `AuthenticationError`.

### Added
- Tests for the one-shot `convert()` path and the PDF upload branch (Python),
  plus transient-error retry coverage (both clients).

## 0.1.0

Initial release: Python and TypeScript clients for the image2ppt API.
