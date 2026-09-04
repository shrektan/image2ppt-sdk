# Changelog

All notable changes to the image2ppt SDKs (Python + TypeScript) are documented
here. The two clients share a single version number.

## 0.5.0

Error handling, end to end. Both clients now report **which pages** of a job did
not convert, and the promise both READMEs make — *every exception this client
raises subclasses `Image2PPTError`* — is finally true.

### Added

- **Both clients** — `page_results` / `pageResults` on a job snapshot: the
  per-page ledger the API returns once a job is terminal. Each entry says whether
  that page converted and, when it did not, why — with a `retryable` flag.
  `creditsRefunded` only ever told you *how many* pages were lost; this tells you
  *which ones*.
  `PAGE_NOT_ATTEMPTED` is the code worth branching on: that page is **not in the
  delivered deck at all**, while every other failed page is present as the
  original image. The field is absent — `None` / `null`, never an empty list —
  while a job is still running and for jobs submitted before September 2026, so
  check that it is present rather than assuming a terminal job carries it.
- **Both clients** — `APIConnectionError` for transport failures (connection
  refused or reset, DNS or TLS failure, a body that stopped arriving), with
  `APITimeoutError` as its subclass for a single request exceeding the
  per-request timeout. The underlying error is preserved as the cause.
- **Both clients** — `MalformedResponseError` for a response this client cannot
  make sense of: a 2xx body that is not JSON (a proxy login page, a captive
  portal), or a body missing a field the contract guarantees.
- **Both clients** — `ServerError` for any 5xx. It subclasses `Image2PPTError`,
  so existing `except Image2PPTError` / `catch (e instanceof Image2PPTError)`
  code is unaffected; it simply lets you tell "the service had a problem, retry
  later" from a request you got wrong.
- **Both clients** — `accept_language` / `acceptLanguage` client option. Error
  `message` text follows the request's `Accept-Language`; these clients sent no
  such header, so callers always got English. Unset by default, which keeps
  today's behavior. It is **not** the same thing as the per-submission `locale`:
  `locale` picks the language of the generated deck, `accept_language` picks the
  language of error messages.

### Fixed

- **Both clients** — a network blip while waiting on a job is retried again,
  instead of aborting the wait. Both clients decided whether a polling failure
  was worth retrying by asking *"is this exception one of ours?"*, which was
  never a sound test. Errors now carry an explicit `is_transient` /
  `isTransient` marker and `wait()` branches on that.
- **Node** — a status poll that hit the per-request timeout aborted the whole
  `wait()` rather than backing off and retrying, contradicting the client's own
  documented behavior. Covered by the same fix.
- **Node** — `timeoutMs` no longer kills a large transfer that is progressing
  normally. It was applied as a hard cap on the entire request, so a 45MB upload
  or a large PPTX download over a slow link was cut off at 60 seconds. It is now
  an **idle** timeout — time with no data moving — which is what the Python
  client's equivalent has always meant. The two clients now agree.
- **Node** — a job status body missing `jobId` or `status` threw nothing at all:
  it produced a job object with undefined fields, and `wait()` then polled it
  until the 30-minute deadline. It now raises `MalformedResponseError`
  immediately, matching what the cancellation response has always done.
- **Python** — transport failures, non-JSON bodies, and job bodies missing
  required fields reached callers as `requests.ConnectionError`,
  `requests.exceptions.JSONDecodeError`, and `KeyError` respectively — none of
  which a documented `except Image2PPTError` catches.
- **Python** — a download that failed *and* then lost the connection while the
  error explanation was still arriving raised a bare
  `requests.ChunkedEncodingError`. The download response is streamed, so its
  error body is read separately from the request itself and had no wrapping of
  its own.
- **Both clients** — the two clients disagreed on malformed bodies: a `jobId` of
  `null`, a page number sent as the string `"3"`, and a non-string page status
  were accepted by one client and rejected by the other. All three are now
  rejected by both, as is a page `error` sent as an array. A `false` value for
  `cancellationRequested` / `finalizing` is a real value, not a missing field,
  in both. The same goes for the fields *inside* a page `error`: a `code` that
  is not a non-empty string reads as `CONVERSION_FAILED`, a `message` that is
  not a string reads as empty (a number is not turned into a sentence), and
  `retryable` is now a real boolean or `false` — never truthiness. That last one
  is the one that mattered: the same bad payload used to tell a Node caller a
  page was worth submitting again and a Python caller that it was not.
- **Both clients** — a job-level `error` that is present but is not an object now
  reads as no error, the same rule the per-page `error` follows. Python crashed
  outright on such a body: `wait()` asked the value for its `code` and raised a
  bare `AttributeError`, which no documented `except Image2PPTError` catches.
  Node did not crash but kept the value in a field typed as an object. The
  original is still on `raw` in both.
- **Python** — the `pageResults` example in the README and in
  `examples/step_by_step.py` read `page.error.code` with no guard, so it raised
  `AttributeError` on a failed page whose `error` this client could not read —
  a value the new parsing rule above produces. The Node examples already guarded.
- **Node** — `Job.cancellationRequested` is coerced to a real boolean instead of
  passing any non-null value through into a field declared `boolean`. The
  cancellation response has always coerced; the job snapshot did not.

### Changed

- **Both clients** — a 5xx now raises `ServerError` rather than the base
  `Image2PPTError`. `ServerError` subclasses it, so `except Image2PPTError`
  keeps working; only code matching on the exact class changes behavior.
- **Both clients** — a transport failure now raises `APIConnectionError` rather
  than the underlying library's exception. Code that caught
  `requests.ConnectionError` or Node's `TypeError` directly must be updated.
  **Submission behavior is unchanged**: a submission whose connection broke is
  still never retried automatically, because a lost response cannot be told
  apart from a rejected one and retrying could charge twice.
- **Node** — `wait()` no longer swallows an unexpected exception. Its old test read
  "not one of ours" as "worth retrying", so a bug inside the client was retried
  silently until the overall deadline and then surfaced as a timeout. It now ends
  the wait and raises. This is the half of the `isTransient` switch that makes
  *fewer* things retryable, and it is the one to read before upgrading.
- **Python** — a poll whose body will not parse now ends `wait()` on the first
  occurrence. `requests` raises its `JSONDecodeError` as a `RequestException`, and
  the old loop retried every `RequestException` to the deadline; it is now a
  `MalformedResponseError`, which is deliberately not transient. Worth knowing if
  you sit behind a proxy that occasionally answers with an HTML page.
- **Node (types)** — `Job.pageResults` is new and is declared required rather than
  optional, so a `Job`-shaped object literal in your own code has to carry it.
  `Image2PPTError` accepts a `cause`, and `ErrorInit` — already exported from the
  errors module — is now re-exported from the package entry point.
- **Docs** — `docs/api.md` / `docs/api.zh.md` re-synced with the published
  contract: per-page results, the finer per-page failure codes, the
  `Accept-Language` rule, and clarified cancellation wording (a page being
  dispatched as cancellation arrives may still run to completion and be billed;
  `JOB_ALREADY_FINISHED` also covers a job past the point where cancellation
  could change the outcome).

### Deployment Notes

**Data impact**: None — the SDKs are thin HTTP clients with no server-side logic
and no persisted state.
**Environment changes**: None — runtime dependencies are unchanged (Python:
`requests` + `Pillow`; Node: `sharp`), and the minimum Python / Node versions are
unchanged.
**Manual operations**: None for consumers, but read **Changed** above before
upgrading if you catch transport exceptions or match on the exact class of a 5xx.
`pip install -U image2ppt` / `npm install image2ppt@latest` otherwise.
**Rollback plan**: PyPI and npm do not allow republishing a version number. If
0.5.0 turns out to be broken, yank/deprecate it and ship 0.5.1; do not attempt to
overwrite 0.5.0.

## 0.4.0

Both clients can now ask the service to stop a conversion job that is already
running, and still keep whatever it managed to finish.

### Added

- **Both clients** — `cancel()` requests graceful server-side cancellation for a
  conversion job. Pages already running finish and remain deliverable; pages that
  have not started are skipped and refunded. Calls are idempotent and return whether
  the job is still winding down.
- **Both clients** — job snapshots expose `cancellation_requested` /
  `cancellationRequested`. A cancellation that settles without a deliverable raises
  `JobCancelledError` from `wait()`; it subclasses `JobFailedError` for compatibility.
  Cancelling a job that finished naturally raises `JobAlreadyFinishedError`.

### Fixed

- **Python** — `get_job()` and `download()` now percent-encode the job id, so a job
  id containing a reserved path character reaches the right endpoint. The Node client
  already did.

### Deployment Notes

**Data impact**: None — the SDKs are thin HTTP clients with no server-side logic
and no persisted state.
**Environment changes**: None — runtime dependencies are unchanged (Python:
`requests` + `Pillow`; Node: `sharp`), and the minimum Python / Node versions are
unchanged.
**Manual operations**: None for consumers. `pip install -U image2ppt` /
`npm install image2ppt@latest` is all that is needed to pick up `cancel()`.
**Rollback plan**: PyPI and npm do not allow republishing a version number. If
0.4.0 turns out to be broken, yank/deprecate it and ship 0.4.1; do not attempt to
overwrite 0.4.0.

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
