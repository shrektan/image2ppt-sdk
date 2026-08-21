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
- **Both clients** — the limits and the batch planner are public:
  `MAX_UPLOAD_BYTES`, `BATCH_TARGET_BYTES`, `MAX_PAGES_PER_JOB`, `UploadItem`,
  `check_submission()` / `checkSubmission()`, `plan_batches()` / `planBatches()`.
- **Both clients** — a submission whose connection breaks mid-upload is retried
  (twice by default, configurable via `max_upload_retries` / `maxUploadRetries`).
  This is safe because a request body that never arrived cannot have created a job
  or reserved credits. A read timeout is deliberately **not** retried — the job may
  already exist, and a retry would charge twice.
- **Both clients** — `PAYLOAD_TOO_LARGE` and HTTP 413 map to `InvalidFileError`.

### Fixed
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
