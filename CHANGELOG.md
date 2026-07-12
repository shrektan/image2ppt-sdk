# Changelog

All notable changes to the image2ppt SDKs (Python + TypeScript) are documented
here. The two clients share a single version number.

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
