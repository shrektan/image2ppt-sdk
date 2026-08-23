# Changelog

All notable changes to the image2ppt SDKs (Python + TypeScript) are documented
here. The two clients share a single version number.

## 0.3.0

The Node client now prepares images before uploading them, the way the Python
client already did. Same files in, fewer bytes on the wire.

### Added
- **TypeScript** — client-side image preparation on `submit()` / `submitAll()`,
  matched to the Python client's rules. A PNG or JPEG that is already at most 1MiB
  with a longest edge of at most 2000px is uploaded byte-for-byte unchanged.
  Anything else — a larger PNG/JPEG, or any WebP/GIF — is fitted inside 2000×2000,
  flattened onto white, and sent as JPEG at the first quality of 90 / 85 / 80 that
  fits in 1MiB. An in-bounds image whose re-encode would come out *larger* keeps
  its original bytes, so nothing is ever made blurrier and bigger at once. PDFs are
  never decoded or compressed; they stream from disk exactly as they are.
- **TypeScript** — the pre-flight size check and automatic batching now measure the
  bytes that actually go on the wire. A 40MB PNG that prepares down to 1MB is
  accepted, where before it was refused locally. The documented limits themselves
  are unchanged.

### Changed
- **TypeScript** — installing the client now also installs `sharp`, which carries a
  platform-specific native binary. The supported Node range narrows to the one
  `sharp` publishes binaries for: **18.17+, 20.3+, or 21+**. Node 19 and Node
  20.0–20.2 are no longer supported. If the native binary is unavailable on your
  platform, only the image calls fail — `account()`, `status()`, `waitFor()` and
  `download()` keep working, and the error says what is missing.
- **Both clients** — a truncated or otherwise damaged image is refused locally with
  `InvalidFileError` instead of being uploaded and charged for. The Python client
  already behaved this way; the Node client now does too.

### Fixed
- **TypeScript** — a file that could not be read (missing path, no permission) was
  reported as an invalid image. It now surfaces the real filesystem error, and a
  genuinely undecodable image says why.

## 0.2.1

When the service marks an SDK version deprecated, you now get one warning in
your logs — and a switch to turn it off.

### Added
- **Both clients** — if a response carries a `Deprecation` header, the client
  logs a single warning: which version you are running, that it has been marked
  deprecated, where to read what changed (`Link`, when present), when support is
  planned to end (`Sunset`, when present), and how to silence the reminder.
  Polling a job every few seconds does **not** repeat it. Default on; turn it off
  with `warn_on_deprecated=False` (Python) or `warnOnDeprecated: false` (Node).
  The reminder can never change what a request returns — a logging handler or a
  `console.warn` replacement that throws is swallowed, and a served response is
  still a served response.
- **TypeScript** — a `VERSION` constant, kept in step with `package.json` by a
  test. The `User-Agent` is built from it, so the two numbers cannot drift the
  way they once did on the Python side.

The `User-Agent` itself (`image2ppt-python/<version>`, `image2ppt-node/<version>`)
shipped in 0.2.0. It still plays no part in authentication or rate limiting and
never changes the outcome of a request.

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

  The check compares against the published 45MB exactly, never less. Refusing a
  submission the service would have accepted is the same class of bug as letting
  through one it will not — only with the client doing the refusing. Batch planning
  is the one place that is deliberately conservative (`BATCH_TARGET_BYTES`, 40MB),
  because starting one more batch costs nothing.
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
- **Both clients** — two new server error codes now map to their own exception
  types instead of falling through to the base class, because their advice is
  opposite. `UploadAbortedError` (`400 UPLOAD_ABORTED`) means the body never
  finished arriving and the server took nothing — **resending the same files is
  safe**, unlike a transport-level connection error, which cannot rule out that the
  job was created and only the response was lost. `MalformedUploadError`
  (`400 MALFORMED_UPLOAD`) means the body was not valid `multipart/form-data` —
  **resending identical bytes will not help**.

- **Both clients** — three more codes from the contract get their own exception
  types instead of landing on the base class, where callers had to compare strings
  to tell them apart: `NoFilesError` (`NO_FILES`), `InvalidAspectRatioError`
  (`INVALID_ASPECT_RATIO`) and `PageRateExceededError` (`PAGE_RATE_EXCEEDED`). The
  last one is worth its own type precisely because it looks like rate limiting and
  is not: a 429 means "not right now", while `PAGE_RATE_EXCEEDED` means this one
  submission can never fit a minute's quota, so waiting does not help — split it.
- **Both clients** — unsupported file types are refused **locally**. Anything
  outside `png` / `jpg` / `jpeg` / `webp` / `gif` / `pdf` raises `InvalidFileError`
  before a connection is opened. It used to be uploaded as an unknown type and
  rejected server-side, which in `submit_all()` / `submitAll()` meant the batches
  ahead of it were already jobs with credits reserved by the time the answer came
  back. The accepted set is known locally, so that failure can cost nothing. The
  trade-off is deliberate: a format the service starts accepting is refused here
  until the SDK is updated and released.
- **Both clients** — every request now carries a `User-Agent`
  (`image2ppt-python/<version>`, `image2ppt-node/<version>`). Without it the
  service cannot tell which client version made a call, so it can never warn anyone
  that theirs is about to stop working. This is the identifier half only; acting on
  it needs the service side.

### Fixed
- **API docs** — four long-standing inaccuracies in this repo's copy of the API
  reference, each of which could break real client code. `downloadUrl` was
  documented as `null` for unfinished jobs; the field is **absent**, so
  `job["downloadUrl"] is None` raises `KeyError` — test for the key, not for
  `None`. Timestamps were shown as ISO-8601 with a `Z` (`2026-07-07T08:00:00Z`);
  they are `YYYY-MM-DD HH:MM:SS` in UTC. `creditsUsed` was shown as non-zero on an
  unfinished job; it is `0` until the job settles (credits are only reserved before
  that). The `416 RANGE_NOT_SATISFIABLE` download error was missing entirely. The
  copy is now a byte-for-byte mirror of the upstream contract plus one language-
  switch line, so this class of drift cannot accumulate again.
- **Both clients** — `convert_all()` / `convertAll()` create the destination
  directory **and prove it writable** before submitting anything, by writing and
  removing a probe file. Doing this afterwards — or only creating the directory,
  which silently succeeds on an existing read-only one — meant an unusable
  destination failed only once every job existed with credits reserved and nowhere
  to put the output.
- **Both clients** — the writable-destination probe no longer opens a predictable
  path. It used to create `.image2ppt-write-test-<pid>` with a plain write, which
  **truncates whatever is already at that path** — including a symlink left in a
  shared output directory, pointing anywhere the process can write. The probe now
  has a random name and is created exclusively (`O_EXCL` / `wx`), and only the entry
  the call itself created is removed.
- **Both clients** — a `Retry-After` of `0` (a legal value meaning "retry now"), a
  sub-second value, or a negative one no longer turns the rate-limit retry into a
  tight loop that re-sends the same multipart body — tens of megabytes of files —
  as fast as the link allows, for as long as the waiting budget lasts. Usable values
  are floored at one second; unusable ones (negative, `nan`, `inf`, an HTTP-date)
  fall back to the documented 5s wait. In Python a negative value additionally
  reached `time.sleep` and raised a bare `ValueError` out of `submit_all()`.
- **Both clients** — `download()` is all-or-nothing. It writes to a temporary file
  beside the destination and renames it into place once the last byte arrives, so a
  connection dropped mid-download can no longer leave a truncated `.pptx` — nor
  destroy a good deck already at that path. `convert_all()` / `convertAll()` reuse
  fixed names (`part-01.pptx`, ...), so a re-run used to be able to replace a
  finished deck with a broken one, and its contract ("the decks already downloaded
  stay on disk") would have counted the broken one.
- **Both clients** — `INVALID_PDF` is now listed in the README error tables. It has
  always mapped to `InvalidFileError`; only the table was missing it.
- **Python** — the docs now say that the 35MB per-file check counts the size
  *after* client-side compression, while the Node client counts the size on disk.
  The two clients enforce the same limits but can disagree about one file, and the
  READMEs used to describe the check in identical words as if they could not.
- **Python** — `__version__` said `0.1.0` while the package was `0.1.1`. Both now
  come from the same release number, with a test guarding against the drift.
- **Both clients** — `rate_limit_max_wait` / `rateLimitMaxWaitMs` now measures what
  its name says: time spent **waiting**. It used to be a wall-clock deadline fixed
  when the call started, so the uploads themselves spent it — a large pile on a slow
  link could exhaust the allowance before the first 429 even arrived, and the option
  quietly became "do not wait at all", with the cutoff decided by link speed rather
  than by anything the caller chose.
- **Both clients** — `Retry-After` is now matched as plain decimal seconds rather than
  handed to each language's number parser. The parsers are lenient in different ways —
  JavaScript's `Number` reads `0x10` as 16, Python's `float` takes `1e3` and `nan` — so
  the same header could mean different things to the two clients. Anything that is not
  plain seconds falls back to the documented 5s wait. The pattern spells out `[0-9]`
  and space-or-tab rather than using `\d` and `strip()`/`trim()`, for the same reason:
  Python's `\d` matches every Unicode decimal digit and JavaScript's matches only
  ASCII, so `Retry-After: ５` would otherwise be five seconds to one client and
  unparseable to the other.
- **Both clients** — no single wait can exceed ~24.8 days, the point where a delay
  stops being representable as a timer: past it Node clamps to *1 millisecond* —
  turning "wait" into "retry at once, at full speed" — while Python raises
  `OverflowError`. This bounds every wait, not only a server-sent `Retry-After`: the
  polling backoff is seeded from the caller's own `poll_interval` / `pollIntervalMs`
  and a 429 without a `Retry-After` reuses that seed unchanged, so a large enough
  `timeout` left it unbounded.
- **Both clients** — one batch is retried at most 10 times after a 429, whatever the
  waiting budget allows. The budget bounds time spent *waiting*, which a service
  answering `Retry-After: 1` barely touches — a 30-minute budget would buy ~1800
  rounds, and every round re-uploads the whole batch.
- **TypeScript** — `formatBytes` is no longer exported from the package root. It is an
  error-message helper, not part of the contract, and Python keeps `format_bytes`
  private; the two SDKs must present the same public surface.

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
